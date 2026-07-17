package service

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/go-redis/redis/v8"
)

const (
	wechatOfficialAPIBaseURL   = "https://api.weixin.qq.com"
	wechatRelayMaxImageBytes   = 10 * 1024 * 1024
	wechatRelayMaxResponse     = 4 * 1024 * 1024
	wechatRelayRequestTimeout  = 20 * time.Second
	wechatRelayEnvelopeMaxTTL  = 2 * time.Minute
	wechatRelayStateTTL        = 24 * time.Hour
	wechatRelayFutureClockSkew = 30 * time.Second
)

var (
	relayRequestIDPattern = regexp.MustCompile(`^[A-Za-z0-9-]{16,64}$`)
	relayNoncePattern     = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)
	relayFingerprint      = regexp.MustCompile(`^[a-f0-9]{64}$`)
	productionRelayLimit  = newRelayConcurrencyLimiter(4, 2)
)

type WeChatRelayPublicKey struct {
	KeyID             string `json:"keyId"`
	Algorithm         string `json:"algorithm"`
	PublicKey         string `json:"publicKey"`
	CredentialBinding string `json:"credentialBinding"`
	ServerTime        int64  `json:"serverTime"`
}

type WeChatRelayError struct {
	Code      string `json:"code"`
	Category  string `json:"category"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
	Outcome   string `json:"outcome,omitempty"`
}

type wechatCredentials struct {
	AppID             string `json:"appId"`
	AppSecret         string `json:"appSecret"`
	CredentialBinding string `json:"credentialBinding"`
	IssuedAt          int64  `json:"issuedAt"`
	ExpiresAt         int64  `json:"expiresAt"`
	Nonce             string `json:"nonce"`
}

type wechatAPIResponse struct {
	ErrCode int    `json:"errcode"`
	ErrMsg  string `json:"errmsg"`
}

type wechatDeleteResponse struct {
	ErrCode *int   `json:"errcode"`
	ErrMsg  string `json:"errmsg"`
}

type wechatTokenResponse struct {
	wechatAPIResponse
	AccessToken string `json:"access_token"`
	ExpiresIn   int    `json:"expires_in"`
}

type wechatArticle struct {
	Title              string `json:"title"`
	Author             string `json:"author"`
	Digest             string `json:"digest"`
	Content            string `json:"content"`
	ContentSourceURL   string `json:"content_source_url,omitempty"`
	ThumbMediaID       string `json:"thumb_media_id"`
	ShowCoverPic       int    `json:"show_cover_pic"`
	NeedOpenComment    int    `json:"need_open_comment"`
	OnlyFansCanComment int    `json:"only_fans_can_comment"`
}

type wechatCreateDraftRequest struct {
	Articles []wechatArticle `json:"articles"`
}

type wechatDraftResponse struct {
	wechatAPIResponse
	MediaID string `json:"media_id"`
}

type wechatImageResponse struct {
	wechatAPIResponse
	MediaID string `json:"media_id,omitempty"`
	URL     string `json:"url,omitempty"`
}

type wechatDraftBatchResponse struct {
	wechatAPIResponse
	TotalCount int `json:"total_count"`
	ItemCount  int `json:"item_count"`
	Items      []struct {
		MediaID string `json:"media_id"`
		Content struct {
			NewsItem []wechatArticle `json:"news_item"`
		} `json:"content"`
		UpdateTime int64 `json:"update_time"`
	} `json:"item"`
}

type wechatMaterialBatchResponse struct {
	wechatAPIResponse
	TotalCount int `json:"total_count"`
	ItemCount  int `json:"item_count"`
	Items      []struct {
		MediaID    string `json:"media_id"`
		Name       string `json:"name"`
		URL        string `json:"url"`
		UpdateTime int64  `json:"update_time"`
	} `json:"item"`
}

type relayOperation struct {
	Action      string
	RequestID   string
	MediaID     string
	FileName    string
	MIMEType    string
	Data        string
	Fingerprint string
	Article     wechatArticle
}

type requestState struct {
	Status      string `json:"status"`
	MediaID     string `json:"mediaId,omitempty"`
	Fingerprint string `json:"fingerprint"`
}

type relayStateStore interface {
	SetNX(ctx context.Context, key string, value string, ttl time.Duration) (bool, error)
	Get(ctx context.Context, key string) (string, error)
	Set(ctx context.Context, key string, value string, ttl time.Duration) error
	Delete(ctx context.Context, key string) error
}

type redisRelayStateStore struct {
	client *redis.Client
}

func (store redisRelayStateStore) SetNX(ctx context.Context, key string, value string, ttl time.Duration) (bool, error) {
	return store.client.SetNX(ctx, key, value, ttl).Result()
}

func (store redisRelayStateStore) Get(ctx context.Context, key string) (string, error) {
	return store.client.Get(ctx, key).Result()
}

func (store redisRelayStateStore) Set(ctx context.Context, key string, value string, ttl time.Duration) error {
	return store.client.Set(ctx, key, value, ttl).Err()
}

func (store redisRelayStateStore) Delete(ctx context.Context, key string) error {
	return store.client.Del(ctx, key).Err()
}

type memoryRelayStateEntry struct {
	value     string
	expiresAt time.Time
}

type memoryRelayStateStore struct {
	mu    sync.Mutex
	now   func() time.Time
	items map[string]memoryRelayStateEntry
}

func newMemoryRelayStateStore() *memoryRelayStateStore {
	return &memoryRelayStateStore{now: time.Now, items: make(map[string]memoryRelayStateEntry)}
}

func (store *memoryRelayStateStore) SetNX(_ context.Context, key string, value string, ttl time.Duration) (bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.deleteExpired(key)
	if _, exists := store.items[key]; exists {
		return false, nil
	}
	store.items[key] = memoryRelayStateEntry{value: value, expiresAt: store.now().Add(ttl)}
	return true, nil
}

func (store *memoryRelayStateStore) Get(_ context.Context, key string) (string, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.deleteExpired(key)
	entry, exists := store.items[key]
	if !exists {
		return "", redis.Nil
	}
	return entry.value, nil
}

func (store *memoryRelayStateStore) Set(_ context.Context, key string, value string, ttl time.Duration) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.items[key] = memoryRelayStateEntry{value: value, expiresAt: store.now().Add(ttl)}
	return nil
}

func (store *memoryRelayStateStore) Delete(_ context.Context, key string) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	delete(store.items, key)
	return nil
}

func (store *memoryRelayStateStore) deleteExpired(key string) {
	if entry, exists := store.items[key]; exists && !entry.expiresAt.After(store.now()) {
		delete(store.items, key)
	}
}

type relayConcurrencyLimiter struct {
	global  chan struct{}
	perUser int
	mu      sync.Mutex
	users   map[int]int
}

func newRelayConcurrencyLimiter(global int, perUser int) *relayConcurrencyLimiter {
	return &relayConcurrencyLimiter{global: make(chan struct{}, global), perUser: perUser, users: make(map[int]int)}
}

func (limiter *relayConcurrencyLimiter) tryAcquire(userID int) (func(), bool) {
	limiter.mu.Lock()
	if limiter.users[userID] >= limiter.perUser {
		limiter.mu.Unlock()
		return nil, false
	}
	limiter.users[userID]++
	limiter.mu.Unlock()
	select {
	case limiter.global <- struct{}{}:
		return func() {
			<-limiter.global
			limiter.mu.Lock()
			limiter.users[userID]--
			if limiter.users[userID] == 0 {
				delete(limiter.users, userID)
			}
			limiter.mu.Unlock()
		}, true
	default:
		limiter.mu.Lock()
		limiter.users[userID]--
		if limiter.users[userID] == 0 {
			delete(limiter.users, userID)
		}
		limiter.mu.Unlock()
		return nil, false
	}
}

type wechatRelay struct {
	baseURL     string
	client      *http.Client
	currentKey  string
	privateKeys map[string]*rsa.PrivateKey
	store       relayStateStore
	now         func() time.Time
}

func GetWeChatRelayPublicKey(userID int, tokenID int) (WeChatRelayPublicKey, *WeChatRelayError) {
	if userID <= 0 || tokenID <= 0 {
		return WeChatRelayPublicKey{}, authenticationRequiredError()
	}
	relay, relayErr := newProductionWeChatRelay()
	if relayErr != nil {
		return WeChatRelayPublicKey{}, relayErr
	}
	privateKey := relay.privateKeys[relay.currentKey]
	encoded, err := x509.MarshalPKIXPublicKey(&privateKey.PublicKey)
	if err != nil {
		return WeChatRelayPublicKey{}, relayServiceError()
	}
	return WeChatRelayPublicKey{
		KeyID:             relay.currentKey,
		Algorithm:         "RSA-OAEP-256",
		PublicKey:         string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: encoded})),
		CredentialBinding: credentialBinding(userID, tokenID),
		ServerTime:        relay.now().Unix(),
	}, nil
}

func ExecuteWeChatOfficialAccountRelay(
	ctx context.Context,
	userID int,
	tokenID int,
	keyID string,
	encryptedCredentials string,
	operation map[string]any,
) (any, *WeChatRelayError) {
	if ctx == nil {
		return nil, invalidRelayRequest("缺少请求上下文")
	}
	if userID <= 0 || tokenID <= 0 {
		return nil, authenticationRequiredError()
	}
	release, acquired := productionRelayLimit.tryAcquire(userID)
	if !acquired {
		return nil, relayBusyError()
	}
	defer release()
	relay, relayErr := newProductionWeChatRelay()
	if relayErr != nil {
		return nil, relayErr
	}
	credentials, credentialErr := relay.decryptCredentials(ctx, userID, tokenID, keyID, encryptedCredentials)
	if credentialErr != nil {
		return nil, credentialErr
	}
	defer func() {
		credentials.AppSecret = ""
	}()
	parsed, operationErr := parseRelayOperation(operation)
	if operationErr != nil {
		return nil, operationErr
	}
	return relay.execute(ctx, userID, credentials, parsed)
}

func newProductionWeChatRelay() (*wechatRelay, *WeChatRelayError) {
	currentID := strings.TrimSpace(os.Getenv("WECHAT_RELAY_KEY_ID"))
	currentPath := strings.TrimSpace(os.Getenv("WECHAT_RELAY_PRIVATE_KEY_PATH"))
	if currentID == "" || currentPath == "" {
		return nil, relayServiceError()
	}
	keys := make(map[string]*rsa.PrivateKey, 2)
	currentKey, err := loadRSAPrivateKey(currentPath)
	if err != nil {
		return nil, relayServiceError()
	}
	keys[currentID] = currentKey
	previousID := strings.TrimSpace(os.Getenv("WECHAT_RELAY_PREVIOUS_KEY_ID"))
	previousPath := strings.TrimSpace(os.Getenv("WECHAT_RELAY_PREVIOUS_PRIVATE_KEY_PATH"))
	if (previousID == "") != (previousPath == "") || previousID == currentID && previousID != "" {
		return nil, relayServiceError()
	}
	if previousID != "" {
		previousKey, loadErr := loadRSAPrivateKey(previousPath)
		if loadErr != nil {
			return nil, relayServiceError()
		}
		keys[previousID] = previousKey
	}
	var store relayStateStore
	if common.RedisEnabled && common.RDB != nil {
		store = redisRelayStateStore{client: common.RDB}
	}
	return &wechatRelay{
		baseURL:     wechatOfficialAPIBaseURL,
		client:      &http.Client{Timeout: wechatRelayRequestTimeout},
		currentKey:  currentID,
		privateKeys: keys,
		store:       store,
		now:         time.Now,
	}, nil
}

func loadRSAPrivateKey(path string) (*rsa.PrivateKey, error) {
	pemBytes, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	defer zeroBytes(pemBytes)
	privateKey, err := parseRSAPrivateKey(pemBytes)
	if err != nil {
		return nil, err
	}
	if privateKey.N.BitLen() < 3072 {
		return nil, errors.New("RSA key must be at least 3072 bits")
	}
	return privateKey, nil
}

func parseRSAPrivateKey(pemBytes []byte) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, errors.New("invalid PEM")
	}
	if key, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		if rsaKey, ok := key.(*rsa.PrivateKey); ok {
			return rsaKey, rsaKey.Validate()
		}
	}
	key, err := x509.ParsePKCS1PrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	return key, key.Validate()
}

func credentialBinding(userID int, tokenID int) string {
	return common.GenerateHMAC(fmt.Sprintf("wechat-relay-credential:%d:%d", userID, tokenID))
}

func (relay *wechatRelay) decryptCredentials(ctx context.Context, userID int, tokenID int, keyID string, ciphertext string) (wechatCredentials, *WeChatRelayError) {
	privateKey, exists := relay.privateKeys[keyID]
	if !exists || len(ciphertext) == 0 || len(ciphertext) > 2048 {
		return wechatCredentials{}, credentialEnvelopeError()
	}
	decoded, err := base64.StdEncoding.Strict().DecodeString(ciphertext)
	if err != nil {
		return wechatCredentials{}, credentialEnvelopeError()
	}
	defer zeroBytes(decoded)
	plaintext, err := rsa.DecryptOAEP(sha256.New(), rand.Reader, privateKey, decoded, nil)
	if err != nil {
		return wechatCredentials{}, credentialEnvelopeError()
	}
	defer zeroBytes(plaintext)
	var credentials wechatCredentials
	if err := common.Unmarshal(plaintext, &credentials); err != nil {
		return wechatCredentials{}, credentialEnvelopeError()
	}
	credentials.AppID = strings.TrimSpace(credentials.AppID)
	credentials.AppSecret = strings.TrimSpace(credentials.AppSecret)
	credentials.CredentialBinding = strings.TrimSpace(credentials.CredentialBinding)
	credentials.Nonce = strings.TrimSpace(credentials.Nonce)
	if len(credentials.AppID) < 8 || len(credentials.AppID) > 64 || len(credentials.AppSecret) < 8 || len(credentials.AppSecret) > 128 {
		return wechatCredentials{}, credentialEnvelopeError()
	}
	if credentials.CredentialBinding != credentialBinding(userID, tokenID) {
		return wechatCredentials{}, &WeChatRelayError{Code: "credential_binding_mismatch", Category: "invalid_request", Message: "公众号临时凭据与当前登录身份不匹配", Retryable: false}
	}
	now := relay.now().Unix()
	maxTTL := int64(wechatRelayEnvelopeMaxTTL / time.Second)
	futureSkew := int64(wechatRelayFutureClockSkew / time.Second)
	if credentials.IssuedAt <= 0 || credentials.ExpiresAt <= credentials.IssuedAt || credentials.ExpiresAt-credentials.IssuedAt > maxTTL || now > credentials.ExpiresAt || credentials.IssuedAt > now+futureSkew {
		return wechatCredentials{}, &WeChatRelayError{Code: "credential_expired", Category: "invalid_request", Message: "公众号临时凭据已过期，请刷新后重试", Retryable: false}
	}
	if !relayNoncePattern.MatchString(credentials.Nonce) {
		return wechatCredentials{}, credentialEnvelopeError()
	}
	if relay.store == nil {
		return wechatCredentials{}, relayStateUnavailableError()
	}
	nonceDigest := sha256.Sum256([]byte(credentials.CredentialBinding + "\x00" + credentials.Nonce))
	nonceKey := "wechat:relay:nonce:v1:" + hex.EncodeToString(nonceDigest[:])
	consumed, storeErr := relay.store.SetNX(ctx, nonceKey, "1", wechatRelayStateTTL)
	if storeErr != nil {
		return wechatCredentials{}, relayStateUnavailableError()
	}
	if !consumed {
		return wechatCredentials{}, &WeChatRelayError{Code: "credential_replayed", Category: "invalid_request", Message: "公众号临时凭据已使用，请刷新后重试", Retryable: false}
	}
	return credentials, nil
}

func zeroBytes(value []byte) {
	for index := range value {
		value[index] = 0
	}
}

func parseRelayOperation(raw map[string]any) (relayOperation, *WeChatRelayError) {
	action, ok := requiredString(raw, "action", 64)
	if !ok {
		return relayOperation{}, invalidRelayRequest("缺少有效的 action")
	}
	allowed := map[string]map[string]bool{
		"test_connection":           {"action": true},
		"get_counts":                {"action": true},
		"upload_article_image":      {"action": true, "fileName": true, "mimeType": true, "data": true},
		"upload_permanent_cover":    {"action": true, "requestId": true, "fingerprint": true, "fileName": true, "mimeType": true, "data": true},
		"find_permanent_material":   {"action": true, "requestId": true, "fingerprint": true},
		"create_draft":              {"action": true, "requestId": true, "fingerprint": true, "article": true},
		"read_draft":                {"action": true, "mediaId": true},
		"find_draft":                {"action": true, "requestId": true, "fingerprint": true, "article": true},
		"delete_draft":              {"action": true, "mediaId": true},
		"delete_permanent_material": {"action": true, "mediaId": true},
	}
	fields, exists := allowed[action]
	if !exists {
		return relayOperation{}, invalidRelayRequest("不支持的微信操作")
	}
	for key := range raw {
		if !fields[key] {
			return relayOperation{}, invalidRelayRequest("请求包含不允许的字段")
		}
	}
	operation := relayOperation{Action: action}
	switch action {
	case "upload_article_image", "upload_permanent_cover":
		var valid bool
		operation.FileName, valid = requiredString(raw, "fileName", 160)
		if !valid || strings.ContainsAny(operation.FileName, `/\\`) {
			return relayOperation{}, invalidRelayRequest("图片文件名无效")
		}
		operation.MIMEType, valid = requiredString(raw, "mimeType", 64)
		if !valid || operation.MIMEType != "image/jpeg" && operation.MIMEType != "image/png" {
			return relayOperation{}, invalidRelayRequest("只支持 JPEG 或 PNG 图片")
		}
		operation.Data, valid = requiredString(raw, "data", base64.StdEncoding.EncodedLen(wechatRelayMaxImageBytes))
		if !valid {
			return relayOperation{}, invalidRelayRequest("图片数据无效或超过 10MB")
		}
		if action == "upload_permanent_cover" {
			if relayErr := parseRequestIdentity(raw, &operation); relayErr != nil {
				return relayOperation{}, relayErr
			}
		}
	case "find_permanent_material":
		if relayErr := parseRequestIdentity(raw, &operation); relayErr != nil {
			return relayOperation{}, relayErr
		}
	case "create_draft", "find_draft":
		if relayErr := parseRequestIdentity(raw, &operation); relayErr != nil {
			return relayOperation{}, relayErr
		}
		article, articleErr := parseArticle(raw["article"])
		if articleErr != nil {
			return relayOperation{}, articleErr
		}
		if articleFingerprint(article) != operation.Fingerprint {
			return relayOperation{}, invalidRelayRequest("fingerprint 与文章内容不一致")
		}
		operation.Article = article
	case "read_draft", "delete_draft", "delete_permanent_material":
		var valid bool
		operation.MediaID, valid = requiredString(raw, "mediaId", 256)
		if !valid {
			return relayOperation{}, invalidRelayRequest("mediaId 无效")
		}
	}
	return operation, nil
}

func parseRequestIdentity(raw map[string]any, operation *relayOperation) *WeChatRelayError {
	var valid bool
	operation.RequestID, valid = requiredString(raw, "requestId", 64)
	if !valid || !relayRequestIDPattern.MatchString(operation.RequestID) {
		return invalidRelayRequest("requestId 无效")
	}
	operation.Fingerprint, valid = requiredString(raw, "fingerprint", 64)
	if !valid || !relayFingerprint.MatchString(operation.Fingerprint) {
		return invalidRelayRequest("fingerprint 无效")
	}
	return nil
}

func requiredString(raw map[string]any, key string, maxLength int) (string, bool) {
	value, ok := raw[key].(string)
	if !ok {
		return "", false
	}
	value = strings.TrimSpace(value)
	return value, value != "" && len(value) <= maxLength
}

func parseArticle(value any) (wechatArticle, *WeChatRelayError) {
	encoded, err := common.Marshal(value)
	if err != nil {
		return wechatArticle{}, invalidRelayRequest("文章格式无效")
	}
	defer zeroBytes(encoded)
	var article wechatArticle
	if err := common.Unmarshal(encoded, &article); err != nil {
		return wechatArticle{}, invalidRelayRequest("文章格式无效")
	}
	article.Title = strings.TrimSpace(article.Title)
	article.Author = strings.TrimSpace(article.Author)
	article.Digest = strings.TrimSpace(article.Digest)
	article.ThumbMediaID = strings.TrimSpace(article.ThumbMediaID)
	if article.Title == "" || len([]rune(article.Title)) > 64 || len([]rune(article.Author)) > 16 || len([]rune(article.Digest)) > 120 {
		return wechatArticle{}, invalidRelayRequest("标题、作者或摘要长度无效")
	}
	if len(article.Content) == 0 || len(article.Content) > 1_000_000 || article.ThumbMediaID == "" || len(article.ThumbMediaID) > 256 {
		return wechatArticle{}, invalidRelayRequest("正文或封面 mediaId 无效")
	}
	if article.ShowCoverPic != 0 && article.ShowCoverPic != 1 || article.NeedOpenComment != 0 && article.NeedOpenComment != 1 || article.OnlyFansCanComment != 0 && article.OnlyFansCanComment != 1 {
		return wechatArticle{}, invalidRelayRequest("文章开关值无效")
	}
	return article, nil
}

func (relay *wechatRelay) execute(ctx context.Context, userID int, credentials wechatCredentials, operation relayOperation) (any, *WeChatRelayError) {
	accessToken, tokenErr := relay.fetchStableToken(ctx, credentials)
	if tokenErr != nil {
		return nil, tokenErr
	}
	switch operation.Action {
	case "test_connection", "get_counts":
		return relay.getCounts(ctx, accessToken)
	case "upload_article_image":
		return relay.uploadImage(ctx, userID, credentials.AppID, accessToken, operation, false)
	case "upload_permanent_cover":
		return relay.uploadImage(ctx, userID, credentials.AppID, accessToken, operation, true)
	case "find_permanent_material":
		return relay.findPermanentMaterial(ctx, userID, credentials.AppID, accessToken, operation)
	case "create_draft":
		return relay.createDraft(ctx, userID, credentials.AppID, accessToken, operation)
	case "read_draft":
		return relay.readDraft(ctx, accessToken, operation.MediaID)
	case "find_draft":
		return relay.findDraft(ctx, userID, credentials.AppID, accessToken, operation)
	case "delete_draft":
		return relay.deleteMedia(ctx, accessToken, operation.MediaID, true)
	case "delete_permanent_material":
		return relay.deleteMedia(ctx, accessToken, operation.MediaID, false)
	default:
		return nil, invalidRelayRequest("不支持的微信操作")
	}
}

func (relay *wechatRelay) fetchStableToken(ctx context.Context, credentials wechatCredentials) (string, *WeChatRelayError) {
	payload, err := common.Marshal(map[string]any{
		"grant_type":    "client_credential",
		"appid":         credentials.AppID,
		"secret":        credentials.AppSecret,
		"force_refresh": false,
	})
	if err != nil {
		return "", relayServiceError()
	}
	defer zeroBytes(payload)
	body, requestErr := relay.do(ctx, http.MethodPost, "/cgi-bin/stable_token", "application/json", bytes.NewReader(payload))
	if requestErr != nil {
		return "", requestErr
	}
	defer zeroBytes(body)
	var response wechatTokenResponse
	if err := common.Unmarshal(body, &response); err != nil {
		return "", wechatUnavailableError("微信返回了无法识别的凭据响应")
	}
	if response.ErrCode != 0 {
		return "", classifyWechatError(response.ErrCode, "token")
	}
	if strings.TrimSpace(response.AccessToken) == "" {
		return "", wechatUnavailableError("微信没有返回可用的访问凭据")
	}
	return response.AccessToken, nil
}

func (relay *wechatRelay) getCounts(ctx context.Context, accessToken string) (any, *WeChatRelayError) {
	materialBody, materialErr := relay.do(ctx, http.MethodGet, "/cgi-bin/material/get_materialcount?access_token="+url.QueryEscape(accessToken), "", nil)
	if materialErr != nil {
		return nil, materialErr
	}
	var material map[string]any
	if err := common.Unmarshal(materialBody, &material); err != nil {
		return nil, wechatUnavailableError("微信返回了无法识别的素材权限响应")
	}
	if code := responseErrorCode(material); code != 0 {
		return nil, classifyWechatError(code, "material")
	}
	draftBody, draftErr := relay.do(ctx, http.MethodGet, "/cgi-bin/draft/count?access_token="+url.QueryEscape(accessToken), "", nil)
	if draftErr != nil {
		return nil, draftErr
	}
	var draft map[string]any
	if err := common.Unmarshal(draftBody, &draft); err != nil {
		return nil, wechatUnavailableError("微信返回了无法识别的草稿权限响应")
	}
	if code := responseErrorCode(draft); code != 0 {
		return nil, classifyWechatError(code, "draft")
	}
	return map[string]any{
		"connected": true,
		"materialCount": map[string]any{
			"image": numericValue(material["image_count"]),
		},
		"draftCount": numericValue(draft["total_count"]),
	}, nil
}

func validateImageData(encoded string, mimeType string) *WeChatRelayError {
	decoder := base64.NewDecoder(base64.StdEncoding.Strict(), strings.NewReader(encoded))
	limited := &io.LimitedReader{R: decoder, N: wechatRelayMaxImageBytes + 1}
	reader := bufio.NewReaderSize(limited, 512)
	header, peekErr := reader.Peek(512)
	if peekErr != nil && !errors.Is(peekErr, io.EOF) {
		return invalidRelayRequest("图片数据无效")
	}
	if len(header) == 0 || http.DetectContentType(header) != mimeType {
		return invalidRelayRequest("图片实际格式与声明格式不一致")
	}
	decodedBytes, err := io.Copy(io.Discard, reader)
	if err != nil {
		return invalidRelayRequest("图片数据无效")
	}
	if decodedBytes > wechatRelayMaxImageBytes || limited.N == 0 {
		return invalidRelayRequest("图片数据无效或超过 10MB")
	}
	return nil
}

func multipartImageStream(encoded string, fileName string) (io.Reader, string, <-chan error) {
	pipeReader, pipeWriter := io.Pipe()
	writer := multipart.NewWriter(pipeWriter)
	contentType := writer.FormDataContentType()
	result := make(chan error, 1)
	go func() {
		part, err := writer.CreateFormFile("media", fileName)
		if err == nil {
			decoder := base64.NewDecoder(base64.StdEncoding.Strict(), strings.NewReader(encoded))
			_, err = io.Copy(part, decoder)
		}
		if err == nil {
			err = writer.Close()
		}
		if err != nil {
			_ = pipeWriter.CloseWithError(err)
		} else {
			_ = pipeWriter.Close()
		}
		result <- err
	}()
	return pipeReader, contentType, result
}

func (relay *wechatRelay) uploadImage(ctx context.Context, userID int, appID string, accessToken string, operation relayOperation, permanent bool) (any, *WeChatRelayError) {
	if relayErr := validateImageData(operation.Data, operation.MIMEType); relayErr != nil {
		return nil, relayErr
	}
	stateKey := ""
	fileName := operation.FileName
	if permanent {
		if relay.store == nil {
			return nil, relayStateUnavailableError()
		}
		stateKey = relayRequestStateKey(userID, appID, "upload_permanent_cover", operation.RequestID)
		if cached, stateErr := relay.beginRequest(ctx, stateKey, operation.Fingerprint); cached != "" || stateErr != nil {
			if cached != "" {
				return map[string]any{"mediaId": cached, "recovered": true, "fingerprint": operation.Fingerprint}, nil
			}
			return nil, stateErr
		}
		fileName = permanentMaterialFilename(operation.Fingerprint, operation.MIMEType)
	}
	stream, contentType, streamResult := multipartImageStream(operation.Data, fileName)
	path := "/cgi-bin/media/uploadimg?access_token=" + url.QueryEscape(accessToken)
	kind := "material"
	if permanent {
		path = "/cgi-bin/material/add_material?access_token=" + url.QueryEscape(accessToken) + "&type=image"
	}
	responseBody, requestErr := relay.do(ctx, http.MethodPost, path, contentType, stream)
	streamErr := <-streamResult
	if requestErr != nil || streamErr != nil {
		if permanent {
			relay.markRequestUnknown(ctx, stateKey, operation.Fingerprint)
		}
		return nil, unknownOutcomeError("微信图片上传结果无法确认，请先检查结果，勿重复上传")
	}
	var response wechatImageResponse
	if err := common.Unmarshal(responseBody, &response); err != nil {
		if permanent {
			relay.markRequestUnknown(ctx, stateKey, operation.Fingerprint)
		}
		return nil, unknownOutcomeError("微信图片上传响应无法识别，请先检查结果，勿重复上传")
	}
	if response.ErrCode != 0 {
		if permanent {
			relay.clearRequest(ctx, stateKey)
		}
		return nil, classifyWechatError(response.ErrCode, kind)
	}
	if permanent && response.MediaID == "" || !permanent && response.URL == "" {
		if permanent {
			relay.markRequestUnknown(ctx, stateKey, operation.Fingerprint)
		}
		return nil, unknownOutcomeError("微信图片上传响应缺少结果，请先检查结果，勿重复上传")
	}
	if permanent {
		if stateErr := relay.completeRequest(ctx, stateKey, operation.Fingerprint, response.MediaID); stateErr != nil {
			return nil, unknownOutcomeError("图片已上传，但保存请求状态失败，请先检查结果")
		}
	}
	return map[string]any{"mediaId": response.MediaID, "url": response.URL, "recovered": false, "fingerprint": operation.Fingerprint}, nil
}

func permanentMaterialFilename(fingerprint string, mimeType string) string {
	extension := ".jpg"
	if mimeType == "image/png" {
		extension = ".png"
	}
	return "wechat-cover-" + fingerprint + extension
}

func (relay *wechatRelay) findPermanentMaterial(ctx context.Context, userID int, appID string, accessToken string, operation relayOperation) (any, *WeChatRelayError) {
	if relay.store == nil {
		return nil, relayStateUnavailableError()
	}
	prefix := "wechat-cover-" + operation.Fingerprint
	matches := make([]struct {
		mediaID string
		url     string
	}, 0, 1)
	offset := 0
	for {
		payload, _ := common.Marshal(map[string]any{"type": "image", "offset": offset, "count": 20})
		body, requestErr := relay.do(ctx, http.MethodPost, "/cgi-bin/material/batchget_material?access_token="+url.QueryEscape(accessToken), "application/json", bytes.NewReader(payload))
		zeroBytes(payload)
		if requestErr != nil {
			return nil, requestErr
		}
		var response wechatMaterialBatchResponse
		if err := common.Unmarshal(body, &response); err != nil {
			return nil, wechatUnavailableError("微信返回了无法识别的永久素材列表")
		}
		if response.ErrCode != 0 {
			return nil, classifyWechatError(response.ErrCode, "material")
		}
		for _, item := range response.Items {
			if (item.Name == prefix+".jpg" || item.Name == prefix+".png") && item.MediaID != "" {
				matches = append(matches, struct {
					mediaID string
					url     string
				}{mediaID: item.MediaID, url: item.URL})
			}
		}
		consumed := len(response.Items)
		if consumed == 0 || offset+consumed >= response.TotalCount {
			break
		}
		offset += consumed
	}
	stateKey := relayRequestStateKey(userID, appID, "upload_permanent_cover", operation.RequestID)
	if len(matches) == 1 {
		if stateErr := relay.completeRequest(ctx, stateKey, operation.Fingerprint, matches[0].mediaID); stateErr != nil {
			return nil, relayStateUnavailableError()
		}
		return map[string]any{"found": true, "mediaId": matches[0].mediaID, "url": matches[0].url, "fingerprint": operation.Fingerprint}, nil
	}
	if len(matches) > 1 {
		return nil, &WeChatRelayError{Code: "ambiguous_material", Category: "invalid_request", Message: "找到多个相同永久素材，请到微信公众平台人工确认", Retryable: false, Outcome: "unknown"}
	}
	return map[string]any{"found": false, "fingerprint": operation.Fingerprint}, nil
}

func (relay *wechatRelay) createDraft(ctx context.Context, userID int, appID string, accessToken string, operation relayOperation) (any, *WeChatRelayError) {
	if relay.store == nil {
		return nil, relayStateUnavailableError()
	}
	stateKey := relayRequestStateKey(userID, appID, "create_draft", operation.RequestID)
	if cached, stateErr := relay.beginRequest(ctx, stateKey, operation.Fingerprint); cached != "" || stateErr != nil {
		if cached != "" {
			return map[string]any{"mediaId": cached, "recovered": true, "fingerprint": operation.Fingerprint}, nil
		}
		return nil, stateErr
	}
	payload, err := common.Marshal(wechatCreateDraftRequest{Articles: []wechatArticle{operation.Article}})
	if err != nil {
		relay.clearRequest(ctx, stateKey)
		return nil, relayServiceError()
	}
	body, requestErr := relay.do(ctx, http.MethodPost, "/cgi-bin/draft/add?access_token="+url.QueryEscape(accessToken), "application/json", bytes.NewReader(payload))
	zeroBytes(payload)
	if requestErr != nil {
		if mediaID, findErr := relay.findDraftMediaID(ctx, accessToken, operation.Article, operation.Fingerprint); findErr == nil && mediaID != "" {
			if stateErr := relay.completeRequest(ctx, stateKey, operation.Fingerprint, mediaID); stateErr == nil {
				return map[string]any{"found": true, "mediaId": mediaID, "recovered": true, "fingerprint": operation.Fingerprint}, nil
			}
		}
		relay.markRequestUnknown(ctx, stateKey, operation.Fingerprint)
		return nil, unknownOutcomeError("草稿新增请求的结果暂时无法确认，请使用“检查结果”恢复，勿重复推送")
	}
	var response wechatDraftResponse
	if err := common.Unmarshal(body, &response); err != nil {
		relay.markRequestUnknown(ctx, stateKey, operation.Fingerprint)
		return nil, unknownOutcomeError("微信草稿响应无法识别，请使用“检查结果”恢复")
	}
	if response.ErrCode != 0 {
		relay.clearRequest(ctx, stateKey)
		return nil, classifyWechatError(response.ErrCode, "draft")
	}
	if response.MediaID == "" {
		relay.markRequestUnknown(ctx, stateKey, operation.Fingerprint)
		return nil, unknownOutcomeError("微信草稿响应缺少 mediaId，请使用“检查结果”恢复")
	}
	if stateErr := relay.completeRequest(ctx, stateKey, operation.Fingerprint, response.MediaID); stateErr != nil {
		return nil, unknownOutcomeError("草稿已创建，但保存请求状态失败，请使用“检查结果”恢复")
	}
	return map[string]any{"mediaId": response.MediaID, "recovered": false, "fingerprint": operation.Fingerprint}, nil
}

func (relay *wechatRelay) readDraft(ctx context.Context, accessToken string, mediaID string) (any, *WeChatRelayError) {
	payload, _ := common.Marshal(map[string]string{"media_id": mediaID})
	body, requestErr := relay.do(ctx, http.MethodPost, "/cgi-bin/draft/get?access_token="+url.QueryEscape(accessToken), "application/json", bytes.NewReader(payload))
	zeroBytes(payload)
	if requestErr != nil {
		return nil, requestErr
	}
	var response map[string]any
	if err := common.Unmarshal(body, &response); err != nil {
		return nil, wechatUnavailableError("微信返回了无法识别的草稿")
	}
	if code := responseErrorCode(response); code != 0 {
		return nil, classifyWechatError(code, "draft")
	}
	return response, nil
}

func (relay *wechatRelay) findDraft(ctx context.Context, userID int, appID string, accessToken string, operation relayOperation) (any, *WeChatRelayError) {
	if relay.store == nil {
		return nil, relayStateUnavailableError()
	}
	mediaID, relayErr := relay.findDraftMediaID(ctx, accessToken, operation.Article, operation.Fingerprint)
	if relayErr != nil {
		return nil, relayErr
	}
	if mediaID == "" {
		return map[string]any{"found": false, "fingerprint": operation.Fingerprint}, nil
	}
	stateKey := relayRequestStateKey(userID, appID, "create_draft", operation.RequestID)
	if stateErr := relay.completeRequest(ctx, stateKey, operation.Fingerprint, mediaID); stateErr != nil {
		return nil, relayStateUnavailableError()
	}
	return map[string]any{"found": true, "mediaId": mediaID, "fingerprint": operation.Fingerprint}, nil
}

func (relay *wechatRelay) findDraftMediaID(ctx context.Context, accessToken string, article wechatArticle, fingerprint string) (string, *WeChatRelayError) {
	matches := make([]string, 0, 1)
	offset := 0
	for {
		payload, _ := common.Marshal(map[string]any{"offset": offset, "count": 20, "no_content": 0})
		body, requestErr := relay.do(ctx, http.MethodPost, "/cgi-bin/draft/batchget?access_token="+url.QueryEscape(accessToken), "application/json", bytes.NewReader(payload))
		zeroBytes(payload)
		if requestErr != nil {
			return "", requestErr
		}
		var response wechatDraftBatchResponse
		if err := common.Unmarshal(body, &response); err != nil {
			return "", wechatUnavailableError("微信返回了无法识别的草稿列表")
		}
		if response.ErrCode != 0 {
			return "", classifyWechatError(response.ErrCode, "draft")
		}
		for _, item := range response.Items {
			if len(item.Content.NewsItem) != 1 {
				continue
			}
			candidate := item.Content.NewsItem[0]
			if articleMatches(candidate, article) && articleFingerprint(candidate) == fingerprint {
				matches = append(matches, item.MediaID)
			}
		}
		consumed := len(response.Items)
		if consumed == 0 || offset+consumed >= response.TotalCount {
			break
		}
		offset += consumed
	}
	if len(matches) == 1 {
		return matches[0], nil
	}
	if len(matches) > 1 {
		return "", &WeChatRelayError{Code: "ambiguous_draft", Category: "invalid_request", Message: "找到多个相同草稿，请到微信公众平台人工确认", Retryable: false, Outcome: "unknown"}
	}
	return "", nil
}

func articleMatches(left wechatArticle, right wechatArticle) bool {
	return left.Title == right.Title && left.Author == right.Author && left.Digest == right.Digest && left.ThumbMediaID == right.ThumbMediaID
}

func articleFingerprint(article wechatArticle) string {
	normalized := article
	normalized.Content = strings.Join(strings.Fields(article.Content), " ")
	encoded, _ := common.Marshal(normalized)
	sum := sha256.Sum256(encoded)
	zeroBytes(encoded)
	return hex.EncodeToString(sum[:])
}

func (relay *wechatRelay) deleteMedia(ctx context.Context, accessToken string, mediaID string, draft bool) (any, *WeChatRelayError) {
	payload, _ := common.Marshal(map[string]string{"media_id": mediaID})
	path := "/cgi-bin/material/del_material?access_token=" + url.QueryEscape(accessToken)
	kind := "material"
	if draft {
		path = "/cgi-bin/draft/delete?access_token=" + url.QueryEscape(accessToken)
		kind = "draft"
	}
	body, requestErr := relay.do(ctx, http.MethodPost, path, "application/json", bytes.NewReader(payload))
	zeroBytes(payload)
	if requestErr != nil {
		return nil, unknownOutcomeError("微信删除请求结果无法确认，请先检查结果，勿重复删除")
	}
	var response wechatDeleteResponse
	if err := common.Unmarshal(body, &response); err != nil || response.ErrCode == nil {
		return nil, unknownOutcomeError("微信删除响应无法识别，请先检查结果，勿重复删除")
	}
	if *response.ErrCode != 0 {
		return nil, classifyWechatError(*response.ErrCode, kind)
	}
	return map[string]any{"deleted": true, "mediaId": mediaID}, nil
}

func (relay *wechatRelay) do(ctx context.Context, method string, path string, contentType string, body io.Reader) ([]byte, *WeChatRelayError) {
	request, err := http.NewRequestWithContext(ctx, method, relay.baseURL+path, body)
	if err != nil {
		return nil, relayServiceError()
	}
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	response, err := relay.client.Do(request)
	if err != nil {
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			return nil, &WeChatRelayError{Code: "network_timeout", Category: "network_timeout", Message: "连接微信超时，请稍后重试", Retryable: true}
		}
		return nil, &WeChatRelayError{Code: "wechat_network_error", Category: "wechat_unavailable", Message: "暂时无法连接微信服务", Retryable: true}
	}
	defer response.Body.Close()
	limited := io.LimitReader(response.Body, wechatRelayMaxResponse+1)
	responseBody, err := io.ReadAll(limited)
	if err != nil {
		return nil, wechatUnavailableError("读取微信响应失败")
	}
	if len(responseBody) > wechatRelayMaxResponse {
		return nil, wechatUnavailableError("微信响应超过安全限制")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, &WeChatRelayError{Code: "wechat_http_error", Category: "wechat_unavailable", Message: "微信服务暂时异常", Retryable: response.StatusCode >= 500}
	}
	return responseBody, nil
}

func responseErrorCode(response map[string]any) int {
	value, ok := response["errcode"]
	if !ok {
		return 0
	}
	switch number := value.(type) {
	case float64:
		return int(number)
	case int:
		return number
	default:
		return -2
	}
}

func numericValue(value any) int {
	switch number := value.(type) {
	case float64:
		return int(number)
	case int:
		return number
	default:
		return 0
	}
}

func classifyWechatError(code int, operationKind string) *WeChatRelayError {
	switch code {
	case 40001:
		if operationKind == "token" {
			return &WeChatRelayError{Code: "wechat_40001", Category: "credential_invalid", Message: "AppID 或 AppSecret 无效，请重新填写", Retryable: false}
		}
		return &WeChatRelayError{Code: "wechat_40001", Category: "wechat_unavailable", Message: "微信访问凭据失效，请稍后重试", Retryable: true}
	case 40013, 40125:
		if operationKind == "token" {
			return &WeChatRelayError{Code: fmt.Sprintf("wechat_%d", code), Category: "credential_invalid", Message: "AppID 或 AppSecret 无效，请重新填写", Retryable: false}
		}
		return &WeChatRelayError{Code: fmt.Sprintf("wechat_%d", code), Category: "wechat_unavailable", Message: "微信拒绝了当前访问凭据", Retryable: false}
	case 40164:
		return &WeChatRelayError{Code: "wechat_40164", Category: "ip_not_whitelisted", Message: "固定出口 IP 未加入公众号白名单，请在微信公众平台配置后重试", Retryable: false}
	case 48001:
		category := "material_permission_denied"
		message := "当前公众号没有素材接口权限"
		if operationKind == "draft" {
			category = "draft_permission_denied"
			message = "当前公众号没有草稿接口权限"
		}
		return &WeChatRelayError{Code: "wechat_48001", Category: category, Message: message, Retryable: false}
	case -1, 45009:
		return &WeChatRelayError{Code: fmt.Sprintf("wechat_%d", code), Category: "wechat_unavailable", Message: "微信服务繁忙或调用频率受限，请稍后重试", Retryable: true}
	default:
		return &WeChatRelayError{Code: fmt.Sprintf("wechat_%d", code), Category: "wechat_unavailable", Message: "微信拒绝了本次操作，请检查公众号权限后重试", Retryable: false}
	}
}

func relayRequestStateKey(userID int, appID string, action string, requestID string) string {
	appDigest := sha256.Sum256([]byte(appID))
	return fmt.Sprintf("wechat:relay:request:v1:%d:%s:%s:%s", userID, hex.EncodeToString(appDigest[:]), action, requestID)
}

func (relay *wechatRelay) beginRequest(ctx context.Context, key string, fingerprint string) (string, *WeChatRelayError) {
	state := requestState{Status: "pending", Fingerprint: fingerprint}
	encoded, err := common.Marshal(state)
	if err != nil {
		return "", relayServiceError()
	}
	created, storeErr := relay.store.SetNX(ctx, key, string(encoded), wechatRelayStateTTL)
	zeroBytes(encoded)
	if storeErr != nil {
		return "", relayStateUnavailableError()
	}
	if created {
		return "", nil
	}
	existing, getErr := relay.store.Get(ctx, key)
	if getErr != nil {
		return "", relayStateUnavailableError()
	}
	var current requestState
	if common.Unmarshal([]byte(existing), &current) != nil {
		return "", relayStateUnavailableError()
	}
	if current.Fingerprint != fingerprint {
		return "", &WeChatRelayError{Code: "request_fingerprint_mismatch", Category: "invalid_request", Message: "requestId 已用于其他内容", Retryable: false}
	}
	if current.Status == "completed" && current.MediaID != "" {
		return current.MediaID, nil
	}
	return "", &WeChatRelayError{Code: "duplicate_request", Category: "invalid_request", Message: "这次操作仍在处理中或结果不确定，请先检查结果", Retryable: false, Outcome: "unknown"}
}

func (relay *wechatRelay) completeRequest(ctx context.Context, key string, fingerprint string, mediaID string) error {
	return relay.setRequestState(ctx, key, requestState{Status: "completed", MediaID: mediaID, Fingerprint: fingerprint})
}

func (relay *wechatRelay) markRequestUnknown(ctx context.Context, key string, fingerprint string) {
	_ = relay.setRequestState(ctx, key, requestState{Status: "unknown", Fingerprint: fingerprint})
}

func (relay *wechatRelay) setRequestState(ctx context.Context, key string, state requestState) error {
	encoded, err := common.Marshal(state)
	if err != nil {
		return err
	}
	defer zeroBytes(encoded)
	return relay.store.Set(ctx, key, string(encoded), wechatRelayStateTTL)
}

func (relay *wechatRelay) clearRequest(ctx context.Context, key string) {
	if relay.store != nil {
		_ = relay.store.Delete(ctx, key)
	}
}

func invalidRelayRequest(message string) *WeChatRelayError {
	return &WeChatRelayError{Code: "invalid_request", Category: "invalid_request", Message: message, Retryable: false}
}

func authenticationRequiredError() *WeChatRelayError {
	return &WeChatRelayError{Code: "authentication_required", Category: "credential_invalid", Message: "登录身份或令牌无效", Retryable: false}
}

func credentialEnvelopeError() *WeChatRelayError {
	return &WeChatRelayError{Code: "invalid_credential_envelope", Category: "invalid_request", Message: "公众号临时凭据无法解密，请刷新后重试", Retryable: false}
}

func relayServiceError() *WeChatRelayError {
	return &WeChatRelayError{Code: "relay_not_configured", Category: "wechat_unavailable", Message: "公众号固定出口服务尚未配置", Retryable: true}
}

func relayStateUnavailableError() *WeChatRelayError {
	return &WeChatRelayError{Code: "relay_state_unavailable", Category: "wechat_unavailable", Message: "公众号请求状态服务暂不可用，未执行本次操作", Retryable: true}
}

func relayBusyError() *WeChatRelayError {
	return &WeChatRelayError{Code: "relay_busy", Category: "rate_limited", Message: "公众号固定出口服务并发已满，请稍后重试", Retryable: true}
}

func wechatUnavailableError(message string) *WeChatRelayError {
	return &WeChatRelayError{Code: "wechat_unavailable", Category: "wechat_unavailable", Message: message, Retryable: true}
}

func unknownOutcomeError(message string) *WeChatRelayError {
	return &WeChatRelayError{Code: "outcome_unknown", Category: "wechat_unavailable", Message: message, Retryable: false, Outcome: "unknown"}
}
