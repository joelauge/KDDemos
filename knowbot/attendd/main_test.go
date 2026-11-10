package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeKnowDrive answers the read routes a depth-1 attend call uses, for one store holding two files.
func fakeKnowDrive(t *testing.T, seen *[]string, mu *sync.Mutex) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		*seen = append(*seen, r.Method+" "+r.URL.Path+" auth="+r.Header.Get("Authorization"))
		mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer test-key" {
			http.Error(w, `{"error":"unauthorized"}`, 401)
			return
		}
		w.Header().Set("content-type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/tags"):
			_, _ = w.Write([]byte(`{"data":[{"tag":"mime:text/markdown","count":2},{"tag":"trial:t1","count":2}],"has_more":false}`))
		case strings.HasSuffix(r.URL.Path, "/search"):
			_, _ = w.Write([]byte(`{"score_kind":"rrf","atoms":[
				{"id":"11","sequence_index":0,"file_id":"file-a","uri":"knowbot/trials/t1/returns.md","score":0.03,"content_hash":"blake3:aa","text":"# Returns\nYou can return any item within 30 days of delivery for a full refund."},
				{"id":"12","sequence_index":2,"file_id":"file-b","uri":"knowbot/trials/t1/shipping.md","score":0.02,"content_hash":"blake3:bb","text":"# Shipping\nOrders ship within 2 business days."}]}`))
		case strings.HasSuffix(r.URL.Path, "/stats"):
			_, _ = w.Write([]byte(`{"totals":{"files":2,"atoms":5,"bytes":900}}`))
		case strings.HasSuffix(r.URL.Path, "/capabilities"):
			_, _ = w.Write([]byte(`{}`))
		default:
			http.Error(w, `{"error":"not found"}`, 404)
		}
	}))
}

func TestAttendAgainstFakeKnowDrive(t *testing.T) {
	var seen []string
	var mu sync.Mutex
	kd := fakeKnowDrive(t, &seen, &mu)
	defer kd.Close()
	s := newServer(apiBase(kd.URL), "test-key", 5*time.Second, false)
	s.noSection.Store(true)
	h := s.routes()

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/attend", strings.NewReader(`{"store":"vs_x","question":"How long do I have to return an item?","scope":{"tags_all":["trial:t1"],"tags_none":["kind:config"]}}`)))
	if rec.Code != 200 {
		t.Fatalf("attend: HTTP %d %s (calls %v)", rec.Code, rec.Body, seen)
	}
	var b struct {
		Status  string `json:"status"`
		Request struct {
			QueryLimit int `json:"query_limit"`
		} `json:"request"`
		Evidence []struct {
			H, FileID, ContentHash, Text string
			AtomIndex                    int `json:"atom_index"`
		} `json:"evidence"`
		Receipt struct {
			BundleDigest string `json:"bundle_digest"`
		} `json:"receipt"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &b); err != nil {
		t.Fatal(err)
	}
	if b.Status == "" || len(b.Evidence) == 0 || b.Receipt.BundleDigest == "" {
		t.Fatalf("bundle: %s", rec.Body)
	}
	if b.Request.QueryLimit != defQueryLimit {
		t.Errorf("query_limit %d, want the small-store default %d", b.Request.QueryLimit, defQueryLimit)
	}
	for _, c := range seen {
		if !strings.Contains(c, " /api/v1/") {
			t.Errorf("call outside the /api prefix: %s", c)
		}
		if r := strings.Fields(c)[0]; r != "GET" {
			t.Errorf("attendd must only read: %s", c)
		}
	}

	// /check: a quote that is in the bundle passes, an invented one is refused
	ev := `[{"h":"e1","text":"You can return any item within 30 days of delivery for a full refund."}]`
	for _, tc := range []struct{ reply, want string }{
		{`{"answer":"Within 30 days.","support":[{"handle":"e1","quote":"return any item within 30 days of delivery"}]}`, "supported"},
		{`{"answer":"Within 60 days.","support":[{"handle":"e1","quote":"return any item within 60 days of delivery"}]}`, "refused"},
	} {
		rec := httptest.NewRecorder()
		body, _ := json.Marshal(map[string]any{"evidence": json.RawMessage(ev), "reply": tc.reply})
		h.ServeHTTP(rec, httptest.NewRequest("POST", "/check", strings.NewReader(string(body))))
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"status":"`+tc.want+`"`) {
			t.Errorf("check %s: HTTP %d %s", tc.want, rec.Code, rec.Body)
		}
	}
}

func TestAttendErrors(t *testing.T) {
	s := newServer("http://127.0.0.1:9/api", "k", 2*time.Second, false)
	h := s.routes()
	for _, tc := range []struct {
		body string
		code int
	}{{`{`, 400}, {`{"store":"vs_x","question":""}`, 400}, {`{"store":"vs_x","question":"returns?"}`, 502}} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("POST", "/attend", strings.NewReader(tc.body)))
		if rec.Code != tc.code {
			t.Errorf("%s: HTTP %d, want %d (%s)", tc.body, rec.Code, tc.code, rec.Body)
		}
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/healthz", nil))
	if rec.Code != 200 {
		t.Errorf("healthz: HTTP %d", rec.Code)
	}
}

func TestControlTagsAndBase(t *testing.T) {
	if !isControl("trial:t1") || !isControl("tfile:abc") || isControl("mime:text/markdown") || isControl("topic:returns") {
		t.Error("control tag rule")
	}
	if apiBase("https://knowdrive.ai/") != "https://knowdrive.ai/api" || apiBase("https://x/api") != "https://x/api" {
		t.Error("apiBase")
	}
}
