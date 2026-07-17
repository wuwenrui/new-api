package service

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/require"
)

const (
	testRelayUserID  = 101
	testRelayTokenID = 202
)

func testRelay(t *testing.T, handler http.Handler) (*wechatRelay, wechatCredentials) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 3072)
	require.NoError(t, err)
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	now := time.Unix(2_000_000_000, 0)
	store := newMemoryRelayStateStore()
	store.now = func() time.Time { return now }
	return &wechatRelay{
			baseURL:     server.URL,
			client:      server.Client(),
			currentKey:  "test-key",
			privateKeys: map[string]*rsa.PrivateKey{"test-key": key},
			store:       store,
			now:         func() time.Time { return now },
		}, wechatCredentials{
			AppID:             "wx-test-app-id",
			AppSecret:         "test-secret-value",
			CredentialBinding: credentialBinding(testRelayUserID, testRelayTokenID),
			IssuedAt:          now.Unix(),
			ExpiresAt:         now.Add(90 * time.Second).Unix(),
			Nonce:             "nonce-value-1234567890",
		}
}

func encryptTestCredentials(t *testing.T, publicKey *rsa.PublicKey, credentials wechatCredentials) string {
	t.Helper()
	plaintext, err := common.Marshal(credentials)
	require.NoError(t, err)
	defer zeroBytes(plaintext)
	ciphertext, err := rsa.EncryptOAEP(sha256.New(), rand.Reader, publicKey, plaintext, nil)
	require.NoError(t, err)
	return base64.StdEncoding.EncodeToString(ciphertext)
}

func testPNGData() string {
	return base64.StdEncoding.EncodeToString([]byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 0, 0, 0, 0})
}

func testArticle() wechatArticle {
	return wechatArticle{
		Title:              "测试文章",
		Author:             "测试作者",
		Digest:             "测试摘要",
		Content:            "<p>正文</p>",
		ThumbMediaID:       "cover-id",
		ShowCoverPic:       1,
		NeedOpenComment:    1,
		OnlyFansCanComment: 0,
	}
}

func TestWeChatRelayCredentialEnvelopeBindsIdentityExpiryAndNonce(t *testing.T) {
	relay, credentials := testRelay(t, http.NotFoundHandler())
	publicKey := &relay.privateKeys[relay.currentKey].PublicKey
	encrypted := encryptTestCredentials(t, publicKey, credentials)

	decoded, relayErr := relay.decryptCredentials(context.Background(), testRelayUserID, testRelayTokenID, relay.currentKey, encrypted)
	require.Nil(t, relayErr)
	require.Equal(t, credentials, decoded)

	_, relayErr = relay.decryptCredentials(context.Background(), testRelayUserID, testRelayTokenID, relay.currentKey, encrypted)
	require.NotNil(t, relayErr)
	require.Equal(t, "credential_replayed", relayErr.Code)
	require.False(t, relayErr.Retryable)

	wrongIdentity := credentials
	wrongIdentity.Nonce = "nonce-wrong-user-123456"
	_, relayErr = relay.decryptCredentials(context.Background(), testRelayUserID+1, testRelayTokenID, relay.currentKey, encryptTestCredentials(t, publicKey, wrongIdentity))
	require.NotNil(t, relayErr)
	require.Equal(t, "credential_binding_mismatch", relayErr.Code)

	expired := credentials
	expired.IssuedAt = relay.now().Add(-3 * time.Minute).Unix()
	expired.ExpiresAt = relay.now().Add(-time.Minute).Unix()
	expired.Nonce = "nonce-expired-123456789"
	_, relayErr = relay.decryptCredentials(context.Background(), testRelayUserID, testRelayTokenID, relay.currentKey, encryptTestCredentials(t, publicKey, expired))
	require.NotNil(t, relayErr)
	require.Equal(t, "credential_expired", relayErr.Code)
}

func TestWeChatRelayAcceptsPreviousKeyDuringCompatibilityWindow(t *testing.T) {
	relay, credentials := testRelay(t, http.NotFoundHandler())
	previous, err := rsa.GenerateKey(rand.Reader, 3072)
	require.NoError(t, err)
	relay.privateKeys["previous-key"] = previous
	credentials.Nonce = "nonce-previous-123456789"

	decoded, relayErr := relay.decryptCredentials(context.Background(), testRelayUserID, testRelayTokenID, "previous-key", encryptTestCredentials(t, &previous.PublicKey, credentials))
	require.Nil(t, relayErr)
	require.Equal(t, credentials.AppID, decoded.AppID)
}

func TestWeChatRelayFailsClosedWhenNonceStoreUnavailable(t *testing.T) {
	relay, credentials := testRelay(t, http.NotFoundHandler())
	relay.store = nil
	encrypted := encryptTestCredentials(t, &relay.privateKeys[relay.currentKey].PublicKey, credentials)

	_, relayErr := relay.decryptCredentials(context.Background(), testRelayUserID, testRelayTokenID, relay.currentKey, encrypted)
	require.NotNil(t, relayErr)
	require.Equal(t, "relay_state_unavailable", relayErr.Code)
}

func TestParseRelayOperationRequiresRecoveryIdentityFields(t *testing.T) {
	fingerprint := strings.Repeat("a", 64)
	cases := []map[string]any{
		{"action": "upload_permanent_cover", "fileName": "cover.png", "mimeType": "image/png", "data": testPNGData(), "fingerprint": fingerprint},
		{"action": "upload_permanent_cover", "fileName": "cover.png", "mimeType": "image/png", "data": testPNGData(), "requestId": "request-1234567890"},
		{"action": "find_permanent_material", "fingerprint": fingerprint},
		{"action": "find_draft", "fingerprint": fingerprint, "article": testArticle()},
	}
	for _, input := range cases {
		_, relayErr := parseRelayOperation(input)
		require.NotNil(t, relayErr, input["action"])
		require.Equal(t, "invalid_request", relayErr.Code)
	}
}

func TestRelayRequestStateKeyContainsRequiredScope(t *testing.T) {
	appID := "wx-account-a"
	requestID := "request-1234567890"
	key := relayRequestStateKey(7, appID, "create_draft", requestID)
	appDigest := sha256.Sum256([]byte(appID))

	require.Contains(t, key, ":7:")
	require.Contains(t, key, hex.EncodeToString(appDigest[:]))
	require.Contains(t, key, ":create_draft:")
	require.True(t, strings.HasSuffix(key, ":"+requestID))
	require.NotEqual(t, key, relayRequestStateKey(8, appID, "create_draft", requestID))
	require.NotEqual(t, key, relayRequestStateKey(7, "wx-account-b", "create_draft", requestID))
}

func TestClassifyWechatErrorsDoesNotMisreportBusiness40001(t *testing.T) {
	require.Equal(t, "credential_invalid", classifyWechatError(40001, "token").Category)
	businessError := classifyWechatError(40001, "draft")
	require.Equal(t, "wechat_unavailable", businessError.Category)
	require.NotContains(t, businessError.Message, "AppSecret")
	require.Equal(t, "ip_not_whitelisted", classifyWechatError(40164, "token").Category)
	require.Equal(t, "material_permission_denied", classifyWechatError(48001, "material").Category)
	require.Equal(t, "draft_permission_denied", classifyWechatError(48001, "draft").Category)
}

func TestWeChatRelayTestsTokenMaterialAndDraftPermissions(t *testing.T) {
	handler := http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/cgi-bin/stable_token":
			var body map[string]any
			require.NoError(t, common.DecodeJson(request.Body, &body))
			require.Equal(t, "wx-test-app-id", body["appid"])
			require.Equal(t, "test-secret-value", body["secret"])
			_, _ = response.Write([]byte(`{"access_token":"redacted-token","expires_in":7200}`))
		case "/cgi-bin/material/get_materialcount":
			require.Equal(t, "redacted-token", request.URL.Query().Get("access_token"))
			_, _ = response.Write([]byte(`{"image_count":7}`))
		case "/cgi-bin/draft/count":
			_, _ = response.Write([]byte(`{"total_count":3}`))
		default:
			http.NotFound(response, request)
		}
	})
	relay, credentials := testRelay(t, handler)

	result, relayErr := relay.execute(context.Background(), testRelayUserID, credentials, relayOperation{Action: "test_connection"})
	require.Nil(t, relayErr)
	payload := result.(map[string]any)
	require.Equal(t, true, payload["connected"])
	require.Equal(t, 3, payload["draftCount"])
}

func TestCreateDraftStatePersistsAcrossRelayInstances(t *testing.T) {
	var draftCalls atomic.Int32
	handler := http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/cgi-bin/draft/add" {
			draftCalls.Add(1)
			_, _ = response.Write([]byte(`{"media_id":"draft-media-id"}`))
			return
		}
		http.NotFound(response, request)
	})
	firstRelay, credentials := testRelay(t, handler)
	secondRelay := *firstRelay
	article := testArticle()
	operation := relayOperation{
		Action: "create_draft", RequestID: "request-persist-123456", Fingerprint: articleFingerprint(article), Article: article,
	}

	first, relayErr := firstRelay.createDraft(context.Background(), testRelayUserID, credentials.AppID, "token", operation)
	require.Nil(t, relayErr)
	require.Equal(t, "draft-media-id", first.(map[string]any)["mediaId"])

	second, relayErr := secondRelay.createDraft(context.Background(), testRelayUserID, credentials.AppID, "token", operation)
	require.Nil(t, relayErr)
	require.Equal(t, true, second.(map[string]any)["recovered"])
	require.Equal(t, int32(1), draftCalls.Load())
}

func TestPermanentMaterialUnknownCanRecoverAndCompleteState(t *testing.T) {
	fingerprint := strings.Repeat("b", 64)
	requestID := "request-material-123456"
	var uploadCalls atomic.Int32
	var uploadedFilename atomic.Value
	handler := http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/cgi-bin/material/add_material":
			uploadCalls.Add(1)
			file, header, err := request.FormFile("media")
			require.NoError(t, err)
			uploadedFilename.Store(header.Filename)
			_, _ = io.Copy(io.Discard, file)
			require.NoError(t, file.Close())
			_, _ = response.Write([]byte(`{}`))
		case "/cgi-bin/material/batchget_material":
			_, _ = response.Write([]byte(`{"total_count":1,"item_count":1,"item":[{"media_id":"cover-media-id","name":"wechat-cover-` + fingerprint + `.png","url":"https://example.test/cover.png"}]}`))
		default:
			http.NotFound(response, request)
		}
	})
	relay, credentials := testRelay(t, handler)
	operation := relayOperation{
		Action: "upload_permanent_cover", RequestID: requestID, Fingerprint: fingerprint,
		FileName: "client-name.png", MIMEType: "image/png", Data: testPNGData(),
	}

	_, relayErr := relay.uploadImage(context.Background(), testRelayUserID, credentials.AppID, "token", operation, true)
	require.NotNil(t, relayErr)
	require.Equal(t, "unknown", relayErr.Outcome)
	require.False(t, relayErr.Retryable)
	require.Equal(t, "wechat-cover-"+fingerprint+".png", uploadedFilename.Load())

	found, relayErr := relay.findPermanentMaterial(context.Background(), testRelayUserID, credentials.AppID, "token", relayOperation{
		Action: "find_permanent_material", RequestID: requestID, Fingerprint: fingerprint,
	})
	require.Nil(t, relayErr)
	require.Equal(t, true, found.(map[string]any)["found"])
	require.Equal(t, "cover-media-id", found.(map[string]any)["mediaId"])

	recovered, relayErr := relay.uploadImage(context.Background(), testRelayUserID, credentials.AppID, "token", operation, true)
	require.Nil(t, relayErr)
	require.Equal(t, true, recovered.(map[string]any)["recovered"])
	require.Equal(t, int32(1), uploadCalls.Load())
}

func TestFindDraftCompletesPersistentRequestState(t *testing.T) {
	article := testArticle()
	fingerprint := articleFingerprint(article)
	handler := http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		require.Equal(t, "/cgi-bin/draft/batchget", request.URL.Path)
		payload, err := common.Marshal(article)
		require.NoError(t, err)
		_, _ = response.Write([]byte(`{"total_count":1,"item_count":1,"item":[{"media_id":"draft-media-id","content":{"news_item":[` + string(payload) + `]}}]}`))
	})
	relay, credentials := testRelay(t, handler)
	operation := relayOperation{Action: "find_draft", RequestID: "request-find-draft-1234", Fingerprint: fingerprint, Article: article}

	found, relayErr := relay.findDraft(context.Background(), testRelayUserID, credentials.AppID, "token", operation)
	require.Nil(t, relayErr)
	require.Equal(t, true, found.(map[string]any)["found"])

	stateKey := relayRequestStateKey(testRelayUserID, credentials.AppID, "create_draft", operation.RequestID)
	cached, stateErr := relay.beginRequest(context.Background(), stateKey, fingerprint)
	require.Nil(t, stateErr)
	require.Equal(t, "draft-media-id", cached)
}

func TestRelayConcurrencyLimitsGlobalAndPerUser(t *testing.T) {
	limiter := newRelayConcurrencyLimiter(4, 2)
	firstRelease, ok := limiter.tryAcquire(1)
	require.True(t, ok)
	secondRelease, ok := limiter.tryAcquire(1)
	require.True(t, ok)
	_, ok = limiter.tryAcquire(1)
	require.False(t, ok)
	thirdRelease, ok := limiter.tryAcquire(2)
	require.True(t, ok)
	fourthRelease, ok := limiter.tryAcquire(3)
	require.True(t, ok)
	_, ok = limiter.tryAcquire(4)
	require.False(t, ok)

	firstRelease()
	secondRelease()
	thirdRelease()
	fourthRelease()
}

func TestUploadImageRejectsOversizedDecodedPayload(t *testing.T) {
	image := bytes.Repeat([]byte{0}, wechatRelayMaxImageBytes+1)
	copy(image, []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'})
	encoded := base64.StdEncoding.EncodeToString(image)
	relayErr := validateImageData(encoded, "image/png")
	require.NotNil(t, relayErr)
	require.Equal(t, "invalid_request", relayErr.Category)
	require.Contains(t, relayErr.Message, "10MB")
}

func TestUploadImageRejectsMismatchedDeclaredFormat(t *testing.T) {
	relayErr := validateImageData(testPNGData(), "image/jpeg")
	require.NotNil(t, relayErr)
	require.Equal(t, "invalid_request", relayErr.Category)
	require.Contains(t, relayErr.Message, "实际格式")
}

func TestUploadImageStreamsMultipartBody(t *testing.T) {
	var received atomic.Int64
	handler := http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		file, header, err := request.FormFile("media")
		require.NoError(t, err)
		require.Equal(t, "body.png", header.Filename)
		count, err := io.Copy(io.Discard, file)
		require.NoError(t, err)
		received.Store(count)
		require.NoError(t, file.Close())
		_, _ = response.Write([]byte(`{"url":"https://example.test/body.png"}`))
	})
	relay, credentials := testRelay(t, handler)

	result, relayErr := relay.uploadImage(context.Background(), testRelayUserID, credentials.AppID, "token", relayOperation{
		Action: "upload_article_image", FileName: "body.png", MIMEType: "image/png", Data: testPNGData(),
	}, false)
	require.Nil(t, relayErr)
	require.Equal(t, "https://example.test/body.png", result.(map[string]any)["url"])
	require.Equal(t, int64(12), received.Load())
}

func TestSideEffectSuccessResponseParseFailureIsUnknownAndNotRetryable(t *testing.T) {
	handler := http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		_, _ = response.Write([]byte(`not-json`))
	})
	relay, credentials := testRelay(t, handler)

	_, relayErr := relay.uploadImage(context.Background(), testRelayUserID, credentials.AppID, "token", relayOperation{
		Action: "upload_article_image", FileName: "body.png", MIMEType: "image/png", Data: testPNGData(),
	}, false)
	require.NotNil(t, relayErr)
	require.Equal(t, "outcome_unknown", relayErr.Code)
	require.Equal(t, "unknown", relayErr.Outcome)
	require.False(t, relayErr.Retryable)
}

func TestDeleteSuccessResponseMissingErrcodeIsUnknownAndNotRetryable(t *testing.T) {
	handler := http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		_, _ = response.Write([]byte(`{}`))
	})
	relay, _ := testRelay(t, handler)

	_, relayErr := relay.deleteMedia(context.Background(), "token", "media-id", true)
	require.NotNil(t, relayErr)
	require.Equal(t, "outcome_unknown", relayErr.Code)
	require.Equal(t, "unknown", relayErr.Outcome)
	require.False(t, relayErr.Retryable)
}

func TestArticleFingerprintNormalizesWhitespace(t *testing.T) {
	left := wechatArticle{Title: "T", Content: "<p>A  B</p>", ThumbMediaID: "m"}
	right := left
	right.Content = "<p>A\n B</p>"
	require.Equal(t, articleFingerprint(left), articleFingerprint(right))
	require.Len(t, articleFingerprint(left), 64)
	require.False(t, strings.Contains(articleFingerprint(left), left.Content))
}
