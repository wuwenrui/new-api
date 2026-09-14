package controller

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The notification transport cannot reach anything except this test's fake Bark.
// In particular, no proxy, worker, production Bark, or QR download is involved.
type manualConsumerLoopbackTransport struct {
	origin string
	base   http.RoundTripper
}

func (transport manualConsumerLoopbackTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Scheme+"://"+req.URL.Host != transport.origin {
		return nil, fmt.Errorf("non-fixture notification origin rejected")
	}
	return transport.base.RoundTrip(req)
}

// This optional cross-repo check runs the actual native clients against Gin and
// disposable SQLite. Admin aliases supply fixture identity, NOT a production
// admin session; the manual facade retains its real current-DB API-key checks.
func TestTokenManualTopUpLawyerDeskConsumer(t *testing.T) {
	directory := os.Getenv("LAWYER_BILLING_CONSUMER_DIR")
	if directory == "" {
		t.Skip("set LAWYER_BILLING_CONSUMER_DIR to the lawyer-billing package for the cross-repo check")
	}
	directory, err := filepath.Abs(directory)
	require.NoError(t, err)
	for _, name := range []string{"manual-topup.js", "newapi.js"} {
		_, err = os.Stat(filepath.Join(directory, "src", name))
		require.NoError(t, err)
	}
	for _, name := range []string{"SQL_DSN", "LOG_SQL_DSN", "REDIS_CONN_STRING"} {
		require.Empty(t, os.Getenv(name), "unset external database/cache configuration before running")
	}
	engine, user, token := setupTokenManualTopUp(t)
	common.QuotaPerUnit = 500000
	operation_setting.ManualTopUpAlipayQRCode = "https://example.invalid/alipay.png"
	require.False(t, common.RedisEnabled)
	require.NoError(t, model.DB.AutoMigrate(&model.Log{}))
	oldLogDB := model.LOG_DB
	model.LOG_DB = model.DB
	t.Cleanup(func() { model.LOG_DB = oldLogDB })
	// Even a failed fake notification cannot fall back to a real recipient.
	admin := &model.User{Username: "manual-consumer-admin", AffCode: "mcadmin", Role: common.RoleRootUser, Status: common.UserStatusEnabled}
	require.NoError(t, model.DB.Create(admin).Error)
	var beforeToken model.Token
	require.NoError(t, model.DB.First(&beforeToken, token.Id).Error)
	foreign := &model.User{Username: "manual-consumer-other", AffCode: "mcother", Group: "default", Status: common.UserStatusEnabled, Quota: 100}
	require.NoError(t, model.DB.Create(foreign).Error)
	require.NoError(t, model.DB.Create(&model.Token{UserId: foreign.Id, Key: "manualotherfixture", Status: common.TokenStatusEnabled, ExpiredTime: -1}).Error)
	now := common.GetTimestamp()
	for _, order := range []model.TopUp{
		{UserId: foreign.Id, TradeNo: "foreign-manual", PaymentProvider: model.PaymentProviderManualTopUp, PaymentMethod: model.PaymentMethodManualWechat, Status: common.TopUpStatusPending, Money: 1, CreateTime: now},
		{UserId: user.Id, TradeNo: "own-online", PaymentProvider: "stripe", CreateTime: now},
		{UserId: user.Id, TradeNo: "own-old", PaymentProvider: model.PaymentProviderManualTopUp, CreateTime: now - 31*24*3600},
	} {
		require.NoError(t, model.DB.Create(&order).Error)
	}

	oldEnabled, oldBark, oldLink := operation_setting.RechargeNotifyEnabled, operation_setting.RechargeNotifyBarkUrl, operation_setting.RechargeNotifyLinkBase
	oldWorker, oldWorkerKey := system_setting.WorkerUrl, system_setting.WorkerValidKey
	oldFetch := *system_setting.GetFetchSetting()
	service.InitHttpClient()
	client := service.GetHttpClient()
	oldTransport := client.Transport
	var notifications atomic.Int32
	received := make(chan struct{}, 2)
	bark := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		notifications.Add(1)
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		received <- struct{}{}
	}))
	t.Cleanup(func() {
		bark.Close()
		client.Transport = oldTransport
		operation_setting.RechargeNotifyEnabled, operation_setting.RechargeNotifyBarkUrl, operation_setting.RechargeNotifyLinkBase = oldEnabled, oldBark, oldLink
		system_setting.WorkerUrl, system_setting.WorkerValidKey = oldWorker, oldWorkerKey
		*system_setting.GetFetchSetting() = oldFetch
	})
	client.Transport = manualConsumerLoopbackTransport{origin: bark.URL, base: &http.Transport{Proxy: nil}}
	system_setting.GetFetchSetting().EnableSSRFProtection = false
	system_setting.WorkerUrl, system_setting.WorkerValidKey = "", ""
	operation_setting.RechargeNotifyEnabled = true
	operation_setting.RechargeNotifyBarkUrl = bark.URL + "/fixture/{{title}}/{{content}}"
	operation_setting.RechargeNotifyLinkBase = "https://example.invalid"

	// These aliases exist only on the loopback test engine, outside the facade.
	adminRoutes := engine.Group("/__fixture", func(c *gin.Context) {
		c.Set("id", admin.Id)
		c.Set("role", admin.Role)
	})
	adminRoutes.POST("/complete", AdminCompleteTopUp)
	adminRoutes.POST("/status-only", ConfirmManualTopUpStatus)
	adminRoutes.GET("/state", func(c *gin.Context) {
		var orders []model.TopUp
		var owner model.User
		var current model.Token
		if err := model.DB.Order("id").Find(&orders).Error; err != nil {
			common.ApiError(c, err)
			return
		}
		if err := model.DB.First(&owner, user.Id).Error; err != nil {
			common.ApiError(c, err)
			return
		}
		if err := model.DB.First(&current, token.Id).Error; err != nil {
			common.ApiError(c, err)
			return
		}
		common.ApiSuccess(c, gin.H{"orders": orders, "wallet": owner.Quota,
			"token_remaining": current.RemainQuota, "token_used": current.UsedQuota, "token_status": current.Status})
	})
	server := httptest.NewServer(engine)
	t.Cleanup(server.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "node", "--input-type=module", "-e", manualTopUpConsumerScript)
	command.Env = append(os.Environ(), "LAWYER_BILLING_CONSUMER_DIR="+directory, "BILLING_FIXTURE_ORIGIN="+server.URL)
	output, err := command.CombinedOutput()
	t.Log(string(output))
	require.NoError(t, err, string(output))
	require.Contains(t, string(output), "actual manual LawyerDesk consumer / Gin / SQLite contract passed")
	for i := 0; i < 2; i++ {
		select {
		case <-received:
		case <-time.After(5 * time.Second):
			t.Fatal("fake Bark notification missing")
		}
	}
	assert.Equal(t, int32(2), notifications.Load())
	var afterToken model.Token
	require.NoError(t, model.DB.First(&afterToken, token.Id).Error)
	assert.Equal(t, beforeToken, afterToken, "neither order creation nor admin settlement changes model-key quota/status")
	var afterUser model.User
	require.NoError(t, model.DB.First(&afterUser, user.Id).Error)
	assert.Equal(t, user.Quota+5000000, afterUser.Quota)
}

const manualTopUpConsumerScript = `
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const root = process.env.LAWYER_BILLING_CONSUMER_DIR;
const { createManualTopupClient } = await import(pathToFileURL(join(root, 'src/manual-topup.js')));
const { createNewApiClient, SITE } = await import(pathToFileURL(join(root, 'src/newapi.js')));
assert.equal(SITE, 'https://model.codingrui.work');
const origin = new URL(process.env.BILLING_FIXTURE_ORIGIN);
assert.equal(origin.protocol, 'http:');
assert.equal(origin.hostname, '127.0.0.1');
const networkFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('unwrapped network request forbidden'); };
const base = '/api/billing/token/manual-topup';
const paths = new Set([base+'/options', base+'/quote', base+'/orders', '/api/usage/token/billing']);
const transport = async (url, init) => {
  const target = new URL(url);
  assert.equal(target.origin, 'https://model.codingrui.work', 'reject every non-site origin before rewrite');
  assert.equal(target.username + target.password, '');
  assert.ok(paths.has(target.pathname), 'only billing facade and metadata allowed');
  assert.equal(init.redirect, 'error');
  assert.ok(['Bearer sk-billingfixture', 'Bearer sk-manualotherfixture', 'Bearer sk-invalidfixture'].includes(init.headers.authorization));
  const response = await networkFetch(new URL(target.pathname + target.search, origin), init);
  assert.match(response.headers.get('cache-control'), /no-store/);
  return response;
};
await assert.rejects(() => transport('https://example.invalid/api/usage/token/billing', {}));
await assert.rejects(() => transport(origin.href, {}));
const options = { resolveCredential: () => 'sk-billingfixture', fetch: transport };
const client = createManualTopupClient(options);
const billing = createNewApiClient(options);
const fixture = async (path, body) => {
  assert.ok(['/state', '/complete', '/status-only'].includes(path));
  const response = await networkFetch(new URL('/__fixture' + path, origin), {
    method: body ? 'POST' : 'GET', redirect: 'error', headers: { 'content-type':'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.success, true);
  return result.data;
};
const invalid = createManualTopupClient({ resolveCredential: () => 'sk-invalidfixture', fetch: transport });
await assert.rejects(() => invalid.options(), { code: 'unauthorized' });
await assert.rejects(() => invalid.create({ amount:10, payment_method:'manual_wechat' }), { code:'unauthorized' });
const before = await fixture('/state');
assert.equal(before.orders.length, 3);
const wallet = await billing.metadata();
assert.equal(wallet.account.remaining, 7000000);
assert.equal(wallet.token.remaining, 3000);
assert.deepEqual(wallet.unit, { type:'CNY', quotaPerUnit:500000, exchangeRate:7.2 });
assert.deepEqual(await client.options(), {
  enabled:true, minAmount:2, amountStep:1, amountOptions:[2,10,20], paymentCurrency:'CNY',
  methods:[{ id:'manual_wechat', name:'微信人工充值' }, { id:'manual_alipay', name:'支付宝人工充值' }],
  instructions:'Include your order number.',
});
assert.deepEqual(await client.history(1), { page:1, pageSize:20, total:0, rows:[] });
const receipts = [];
for (const method of ['manual_wechat', 'manual_alipay']) {
  const input = { amount:10, payment_method:method };
  assert.deepEqual(await client.quote(input), {
    amount:10, paymentMethod:method, money:36, paymentCurrency:'CNY', expectedQuota:5000000,
  }); // Price 3 * owner group 1.5 * discount .8, NOT exchange 7.2 or token group 9.
  const quoted = await fixture('/state');
  assert.equal(quoted.orders.length, 3 + receipts.length, 'quote never creates');
  const receipt = await client.create(input);
  assert.equal(receipt.status, 'pending');
  assert.equal(receipt.money, 36);
  assert.equal(receipt.paymentCurrency, 'CNY');
  assert.equal(receipt.paymentMethod, method);
  assert.equal(receipt.paymentName, method === 'manual_wechat' ? '微信人工充值' : '支付宝人工充值');
  assert.equal(receipt.qrUrl, 'https://example.invalid/' + (method === 'manual_wechat' ? 'wechat' : 'alipay') + '.png');
  assert.equal(receipt.instructions, 'Include your order number.');
  receipts.push(receipt);
  const state = await fixture('/state');
  assert.equal(state.orders.length, 3 + receipts.length, 'exactly one existing TopUp per create');
  const persisted = state.orders.filter(row => row.trade_no === receipt.tradeNo);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].amount, 10);
  assert.equal(persisted[0].money, 36);
  assert.equal(persisted[0].payment_method, method);
  assert.equal(persisted[0].payment_provider, 'manual_topup');
  assert.equal(persisted[0].status, 'pending');
  assert.equal(state.wallet, before.wallet);
  assert.equal(state.token_remaining, before.token_remaining);
  assert.equal(state.token_used, before.token_used);
  assert.equal(state.token_status, before.token_status);
  assert.deepEqual((await billing.metadata()).account, wallet.account);
}
assert.notEqual(receipts[0].tradeNo, receipts[1].tradeNo);
const history = await client.history(1);
assert.equal(history.total, 2);
assert.deepEqual(history.rows.map(row => row.tradeNo), receipts.map(row => row.tradeNo).reverse());
assert.ok(history.rows.every(row => row.status === 'pending' && row.money === 36 && row.completedAt === null && row.createdAt > 0));
const other = createManualTopupClient({ resolveCredential: () => 'sk-manualotherfixture', fetch: transport });
const otherHistory = await other.history(1);
assert.equal(otherHistory.total, 1);
assert.deepEqual(otherHistory.rows.map(row => row.tradeNo), ['foreign-manual']);
for (let attempt = 0; attempt < 2; attempt++) {
  await fixture('/complete', { trade_no:receipts[0].tradeNo, amount:10 });
  const credited = await billing.metadata();
  assert.equal(credited.account.remaining, wallet.account.remaining + 5000000, 'credit exactly once');
  assert.deepEqual(credited.token, wallet.token);
}
const creditedHistory = await client.history(1);
assert.equal(creditedHistory.rows.find(row => row.tradeNo === receipts[0].tradeNo).status, 'success');
const creditedWallet = (await billing.metadata()).account;
for (let attempt = 0; attempt < 2; attempt++) {
  await fixture('/status-only', { trade_nos:[receipts[1].tradeNo] });
  const processed = (await client.history(1)).rows.find(row => row.tradeNo === receipts[1].tradeNo);
  assert.equal(processed.status, 'success'); // Client preserves success; UI must label processed, not credited.
  assert.ok(processed.completedAt > 0);
  assert.deepEqual((await billing.metadata()).account, creditedWallet, 'processed does not imply credited');
}
assert.equal((await fixture('/state')).orders.length, 5, 'admin completion creates no additional order');
console.log('actual manual LawyerDesk consumer / Gin / SQLite contract passed');
`
