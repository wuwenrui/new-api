package controller

import (
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// TestTokenBillingLawyerDeskConsumer exercises the actual JS client against the
// authenticated Gin endpoint and disposable database, rather than matching mocks.
func TestTokenBillingLawyerDeskConsumer(t *testing.T) {
	directory := os.Getenv("LAWYER_BILLING_CONSUMER_DIR")
	if directory == "" {
		t.Skip("set LAWYER_BILLING_CONSUMER_DIR to the lawyer-billing package for the cross-repo check")
	}
	directory, err := filepath.Abs(directory)
	require.NoError(t, err)
	_, err = os.Stat(filepath.Join(directory, "src", "newapi.js"))
	require.NoError(t, err)
	engine, _, _ := setupBillingEndpoint(t)
	server := httptest.NewServer(engine)
	t.Cleanup(server.Close)
	const script = `
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const root = process.env.LAWYER_BILLING_CONSUMER_DIR;
const { createNewApiClient, SITE } = await import(pathToFileURL(join(root, 'src/newapi.js')));
const { measureRequest, estimateCost } = await import(pathToFileURL(join(root, 'src/estimate.js')));
const client = createNewApiClient({
  resolveCredential: () => 'sk-billingfixture',
  fetch: (url, init) => {
    const target = new URL(url);
    assert.equal(target.origin, SITE);
    assert.equal(target.pathname, '/api/usage/token/billing');
    assert.equal(init.redirect, 'error');
    return fetch(new URL(target.pathname + target.search, process.env.BILLING_FIXTURE_ORIGIN), init);
  },
});
const result = await client.metadata('billing-test');
assert.equal(result.account.remaining, 7000000);
assert.equal(result.token.remaining, 3000);
assert.equal(result.unit.quotaPerUnit, 700000);
assert.equal(result.unit.exchangeRate, 7.2);
assert.equal(result.account.remaining / result.unit.quotaPerUnit * result.unit.exchangeRate, 72);
assert.deepEqual(result.pricing.rates, [{ group: 'vip', input: 1, output: 3, cacheRead: .25, cacheWrite: null }]);
const measurement = measureRequest({ provider:'lawyercopilot', model:'billing-test', maxTokens:100, messages:[{role:'user',content:[{type:'text',text:'合同'}]}] }, {});
const quote = estimateCost(measurement, result);
assert.equal(quote.low, 2.5);
assert.equal(quote.high, 310);
const unknown = await client.metadata('not-authorized');
assert.equal(unknown.pricing.status, 'unavailable');
assert.equal(estimateCost(measurement, unknown).status, 'unavailable');
console.log('actual LawyerDesk consumer / Gin / SQLite contract passed');
`
	command := exec.Command("node", "--input-type=module", "-e", script)
	command.Env = append(os.Environ(), "LAWYER_BILLING_CONSUMER_DIR="+directory, "BILLING_FIXTURE_ORIGIN="+server.URL)
	output, err := command.CombinedOutput()
	require.NoError(t, err, string(output))
	require.Contains(t, string(output), "contract passed")
}
