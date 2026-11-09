import { jsxs as b, jsx as i, Fragment as j } from "react/jsx-runtime";
import { useState as L, useId as G, useRef as C, memo as z, useLayoutEffect as W, useEffect as T } from "react";
import { createPortal as H } from "react-dom";
const V = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/];
function Z(t) {
  if (typeof t != "string" || t === "")
    return 0;
  const n = [...t].length, r = V.filter((f) => f.test(t)).length;
  return (n >= 12 ? 1 : 0) + (n >= 16 ? 1 : 0) + (r >= 2 ? 1 : 0) + (r >= 3 ? 1 : 0);
}
const Q = [1, 2, 3, 4];
function U({ off: t }) {
  return /* @__PURE__ */ b(
    "svg",
    {
      width: "18",
      height: "18",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "2",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      focusable: "false",
      children: [
        /* @__PURE__ */ i("path", { d: "M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" }),
        /* @__PURE__ */ i("circle", { cx: "12", cy: "12", r: "3" }),
        t && /* @__PURE__ */ i("path", { d: "M3 3l18 18" })
      ]
    }
  );
}
function _(t, n) {
  return n ? n === t ? "match" : n.length < t.length && t.startsWith(n) ? "idle" : "mismatch" : "idle";
}
function ce({
  id: t,
  label: n,
  value: r,
  onChange: f,
  requirements: x,
  showStrength: o = !0,
  confirm: d,
  autoComplete: s = "new-password",
  revealLabel: u = "Show password",
  hideLabel: k = "Hide password",
  metLabel: y = "met",
  unmetLabel: p = "not met",
  disabled: v = !1
}) {
  const [m, l] = L(!1), h = r || "", N = m ? "text" : "password", e = x || [], a = `${t}-reqs`, c = d ? _(h, d.value || "") : "idle", w = d ? `${d.id}-match` : void 0;
  return /* @__PURE__ */ b("div", { className: "pw-field", children: [
    /* @__PURE__ */ b("div", { className: "field", children: [
      /* @__PURE__ */ i("label", { className: "flabel", htmlFor: t, children: n }),
      /* @__PURE__ */ b("div", { className: "pw-input", children: [
        /* @__PURE__ */ i(
          "input",
          {
            id: t,
            className: "input",
            type: N,
            value: h,
            onChange: (g) => f(g.target.value),
            autoComplete: s,
            autoCapitalize: "off",
            autoCorrect: "off",
            spellCheck: !1,
            disabled: v,
            "aria-describedby": e.length > 0 ? a : void 0
          }
        ),
        /* @__PURE__ */ i(
          "button",
          {
            type: "button",
            className: "pw-reveal",
            "aria-label": m ? k : u,
            "aria-controls": d ? `${t} ${d.id}` : t,
            disabled: v,
            onClick: () => l((g) => !g),
            children: /* @__PURE__ */ i(U, { off: m })
          }
        )
      ] }),
      o && /* @__PURE__ */ i("div", { className: "pw-strength", "data-score": Z(h), "aria-hidden": "true", children: Q.map((g) => /* @__PURE__ */ i("span", { className: "pw-strength-seg" }, g)) }),
      e.length > 0 && /* @__PURE__ */ i("ul", { id: a, className: "pw-reqs", "aria-live": "polite", children: e.map((g) => {
        const $ = !!g.test(h);
        return /* @__PURE__ */ b("li", { className: "pw-req" + ($ ? " met" : ""), "data-met": $ ? "true" : "false", children: [
          /* @__PURE__ */ i("span", { className: "pw-req-glyph", "aria-hidden": "true" }),
          g.label,
          /* @__PURE__ */ i("span", { className: "sr-only", children: ", " + ($ ? y : p) })
        ] }, g.id);
      }) })
    ] }),
    d && /* @__PURE__ */ b("div", { className: "field" + (c === "mismatch" ? " error" : c === "match" ? " pw-confirm-ok" : ""), children: [
      /* @__PURE__ */ i("label", { className: "flabel", htmlFor: d.id, children: d.label }),
      /* @__PURE__ */ i(
        "input",
        {
          id: d.id,
          className: "input",
          type: N,
          value: d.value || "",
          onChange: (g) => d.onChange(g.target.value),
          autoComplete: s,
          autoCapitalize: "off",
          autoCorrect: "off",
          spellCheck: !1,
          disabled: v,
          "aria-invalid": c === "mismatch" ? !0 : void 0,
          "aria-describedby": w
        }
      ),
      /* @__PURE__ */ i(
        "p",
        {
          id: w,
          className: "pw-match" + (c === "match" ? " met" : c === "mismatch" ? " unmet" : ""),
          "aria-live": "polite",
          children: c === "match" ? d.matchLabel ?? "Passwords match" : c === "mismatch" ? d.mismatchLabel ?? "Passwords don't match" : ""
        }
      )
    ] })
  ] });
}
const J = ["security", "time", "info", "ok", "neutral"];
function M({ children: t }) {
  return /* @__PURE__ */ i(
    "svg",
    {
      width: "18",
      height: "18",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "2.2",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      focusable: "false",
      children: t
    }
  );
}
const X = {
  security: /* @__PURE__ */ b(M, { children: [
    /* @__PURE__ */ i("rect", { x: "4", y: "11", width: "16", height: "10", rx: "2" }),
    /* @__PURE__ */ i("path", { d: "M8 11V7a4 4 0 0 1 8 0v4" })
  ] }),
  time: /* @__PURE__ */ b(M, { children: [
    /* @__PURE__ */ i("circle", { cx: "12", cy: "12", r: "9" }),
    /* @__PURE__ */ i("path", { d: "M12 7v5l3 2" })
  ] }),
  info: /* @__PURE__ */ b(M, { children: [
    /* @__PURE__ */ i("circle", { cx: "12", cy: "12", r: "9" }),
    /* @__PURE__ */ i("path", { d: "M12 11v5M12 8h.01" })
  ] }),
  ok: /* @__PURE__ */ b(M, { children: [
    /* @__PURE__ */ i("path", { d: "M22 11.08V12a10 10 0 1 1-5.93-9.14" }),
    /* @__PURE__ */ i("path", { d: "m22 4-10 10.01-3-3" })
  ] }),
  neutral: /* @__PURE__ */ b(M, { children: [
    /* @__PURE__ */ i("circle", { cx: "12", cy: "12", r: "9" }),
    /* @__PURE__ */ i("path", { d: "M12 8v5M12 16h.01" })
  ] })
};
function de({ tone: t, title: n, children: r, actions: f, icon: x }) {
  const o = J.includes(t) ? t : "neutral", d = (u) => u != null && u !== !1, s = d(r);
  return /* @__PURE__ */ b("div", { className: "status-card status-card-" + o, role: o === "security" ? "alert" : "status", children: [
    /* @__PURE__ */ b("div", { className: "status-card-head", children: [
      /* @__PURE__ */ i("span", { className: "status-card-icon", "aria-hidden": "true", children: x ?? X[o] }),
      /* @__PURE__ */ i("div", { className: "status-card-title", children: n })
    ] }),
    s && /* @__PURE__ */ i("div", { className: "status-card-body", children: r }),
    d(f) && f !== 0 && /* @__PURE__ */ i("div", { className: "status-card-actions", children: f })
  ] });
}
function le({ tabs: t = [], value: n, onChange: r, label: f }) {
  var h, N;
  const x = G(), [o, d] = L((h = t[0]) == null ? void 0 : h.id), s = n !== void 0 ? n : o, u = t.some((e) => e.id === s) ? s : (N = t[0]) == null ? void 0 : N.id, k = C(/* @__PURE__ */ new Set());
  u !== void 0 && k.current.add(u);
  const y = C([]), p = (e) => {
    n === void 0 && d(e), r == null || r(e);
  }, v = (e) => {
    var g;
    if (e.altKey || e.ctrlKey || e.metaKey)
      return;
    const a = t.length, c = t.findIndex(($) => $.id === u), w = { ArrowRight: (c + 1) % a, ArrowLeft: (c - 1 + a) % a, Home: 0, End: a - 1 }[e.key];
    a === 0 || w === void 0 || (e.preventDefault(), p(t[w].id), (g = y.current[w]) == null || g.focus());
  }, m = (e) => `${x}tab-${e}`, l = (e) => `${x}panel-${e}`;
  return /* @__PURE__ */ b(j, { children: [
    /* @__PURE__ */ i("div", { className: "tabs", role: "tablist", "aria-label": f, onKeyDown: v, children: t.map((e, a) => {
      const c = e.id === u;
      return /* @__PURE__ */ b(
        "button",
        {
          ref: (w) => {
            y.current[a] = w;
          },
          type: "button",
          role: "tab",
          className: "tab",
          id: m(e.id),
          "aria-selected": c,
          "aria-controls": l(e.id),
          tabIndex: c ? 0 : -1,
          onClick: () => p(e.id),
          children: [
            e.label,
            typeof e.count == "number" && /* @__PURE__ */ i("span", { className: "tab-count", children: e.count })
          ]
        },
        e.id
      );
    }) }),
    t.map((e) => /* @__PURE__ */ i(
      "div",
      {
        className: "tab-panel",
        role: "tabpanel",
        id: l(e.id),
        "aria-labelledby": m(e.id),
        hidden: e.id !== u,
        children: k.current.has(e.id) ? e.content : null
      },
      e.id
    ))
  ] });
}
const q = [
  { key: "saved", name: "Saved", explain: "The file's bytes are stored and can be downloaded." },
  { key: "text", name: "Text extracted", explain: "The words were pulled out of the file so they can be indexed." },
  { key: "fulltext", name: "Full-text", explain: "Split into pieces and indexed by its words: full-text search finds it." },
  { key: "vector", name: "Vector", explain: "Every piece embedded by meaning: vector and hybrid search find it." }
], A = q.map((t) => t.key);
function Y(t) {
  t = t ?? [];
  const n = (r) => t.some((f) => f.toLowerCase() === r);
  return n("x-knowdb-no-extract") ? { target: 1, directive: "x-knowdb-no-extract" } : n("x-knowdb-no-chunk") ? { target: 2, directive: "x-knowdb-no-chunk" } : n("x-knowdb-no-vector") ? { target: 3, directive: "x-knowdb-no-vector" } : { target: 4 };
}
const ee = {
  fetching: "Fetching",
  queued: "Queued",
  working: "Working",
  embedding: "Full-text only",
  searchable: "Searchable",
  "partly-vector": "Partly vector-searchable",
  "nothing-searchable": "Nothing searchable",
  "fulltext-only": "Full-text only",
  "text-only": "Text only",
  "stored-only": "Stored only",
  "not-embedded": "Not embedded",
  failed: "Failed",
  quarantined: "Failed",
  retired: "Retired"
}, te = {
  fetching: "working",
  queued: "working",
  working: "working",
  embedding: "working",
  searchable: "ok",
  "partly-vector": "ok",
  "fulltext-only": "ok",
  "text-only": "ok",
  "stored-only": "ok",
  "nothing-searchable": "muted",
  "not-embedded": "muted",
  retired: "muted",
  failed: "failed",
  quarantined: "failed"
}, ne = /* @__PURE__ */ new Set(["error", "quarantined", "failed"]);
function S(t) {
  if (t < 1024)
    return `${t} B`;
  const n = ["KB", "MB", "GB", "TB"];
  let r = t / 1024, f = 0;
  for (; r >= 1024 && f < n.length - 1; )
    r /= 1024, f++;
  return `${r < 10 ? r.toFixed(1) : Math.round(r)} ${n[f]}`;
}
const ae = (t) => Math.max(0, Math.min(1, t));
function F(t, n) {
  return t === 3 ? { outcome: "fulltext-only", hint: `Indexed by its words, by request (${n}). Vector and hybrid search won't find it.` } : t === 2 ? { outcome: "text-only", hint: `Text extracted but not indexed, by request (${n}). Not searchable.` } : { outcome: "stored-only", hint: `Kept as-is, by request (${n}). Nothing extracted or searchable.` };
}
function ie(t) {
  const n = Object.fromEntries(Object.entries(t).filter(([, a]) => a != null)), r = (n.phase || "").toLowerCase(), { target: f, directive: x } = Y(n.tags), o = ne.has(r), d = !!n.unsupported && (o || r === "completed" && !((n.atomCount ?? 0) > 0)), s = d ? 1 : f, u = n.atomCount ?? 0, k = n.atomsVectorized, y = k !== void 0, p = q.map((a, c) => ({ ...a, state: c < s ? "todo" : "skipped" })), v = (a, c, w) => {
    a >= s || (p[a].state = c, w !== void 0 && (p[a].progress = ae(w)));
  }, m = (a) => {
    for (let c = 0; c < a; c++)
      v(c, "done");
  };
  let l, h;
  if (d)
    m(1), l = "not-embedded", h = "Stored, but this file type isn't processed, so search won't find its contents.";
  else if (o) {
    let a = n.failedAt ? A.indexOf(n.failedAt) : -1;
    (a < 0 || a >= s) && (a = Math.min(1, s - 1)), m(a), v(a, "failed"), l = r === "quarantined" ? "quarantined" : "failed";
    const c = n.failedAt && A.indexOf(n.failedAt) === a ? `at ${q[a].name}.` : "— the server doesn't say at which step.";
    h = l === "quarantined" ? `Quarantined by the server after repeated failures ${c}` : `Processing failed ${c}`, n.reason && (h += ` ${n.reason}`);
  } else
    switch (r) {
      case "fetching": {
        const a = n.bytesTotal ?? 0;
        v(0, "active", a > 0 ? (n.bytesFetched ?? 0) / a : void 0), a > 0 && (p[0].detail = `${S(n.bytesFetched ?? 0)} of ${S(a)}`), l = "fetching", h = "Fetching the file from its source.";
        break;
      }
      case "pending":
        m(1), v(1, "waiting"), l = "queued", h = "Saved, waiting its turn to be processed.";
        break;
      case "text_extracted":
        if (s <= 2) {
          m(s);
          const a = F(s, x);
          l = a.outcome, h = a.hint;
          break;
        }
        m(2), v(2, "active"), l = "working", h = "Text extracted; splitting and indexing it. Not searchable yet.";
        break;
      case "chunked":
        if (s <= 3) {
          m(s);
          const a = F(s, x);
          l = a.outcome, h = a.hint;
          break;
        }
        m(3), v(3, "active", u > 0 && y ? k / u : void 0), l = "embedding", h = "Full-text search finds it now; vector search will when embedding finishes.";
        break;
      case "completed": {
        if (m(s), s >= 3 && y && u === 0)
          v(2, "todo"), v(3, "todo"), l = "nothing-searchable", h = "Processed, but no text came out of it, so search won't find it.";
        else if (s === 4 && y && u > 0 && k === 0)
          p[3].state = "todo", l = "fulltext-only", h = "Indexed by its words, but none of its pieces are embedded, so vector search won't find it.";
        else if (s === 4 && y && u > 0 && k < u)
          v(3, "partial", k / u), l = "partly-vector", h = `Full-text search finds it; vector search finds ${k} of ${u} pieces.`;
        else if (s === 4)
          l = "searchable", h = "Full-text and vector search both find it.", y || (h += " (Counts not reported yet.)");
        else {
          const a = F(s, x);
          l = a.outcome, h = a.hint, s >= 3 && !y && (h += " (Counts not reported yet.)");
        }
        break;
      }
      case "retained":
        m(1), l = "retired", h = "This version was retired by the server.";
        break;
      default:
        m(1), v(1, "active"), l = "working", h = "Being processed. Not searchable yet.";
    }
  n.bytes !== void 0 && p[0].detail === void 0 && p[0].state === "done" && (p[0].detail = S(n.bytes)), p[2].state === "done" && u > 0 && (p[2].detail = `${u} pieces`), (p[3].state === "active" || p[3].state === "partial") && u > 0 && y ? p[3].detail = `${k} / ${u} embedded` : p[3].state === "done" && u > 0 && (p[3].detail = `${u} embedded`);
  const N = p[3], e = {
    fullText: p[2].state === "done" ? "yes" : "no",
    vector: N.state === "done" ? "yes" : N.state === "partial" || N.state === "active" && (N.progress ?? 0) > 0 ? "partial" : "no"
  };
  return { stages: p, outcome: l, tone: te[l], label: ee[l], hint: h, searchable: e };
}
function R(t) {
  const n = t.stages.find((r) => (r.state === "active" || r.state === "partial") && r.detail);
  return n ? `${t.label}: ${n.detail}` : t.label;
}
const P = 3.25, D = 2 * Math.PI * P, E = 8, O = (t, n, r) => Math.max(n, Math.min(t, r));
function K({ state: t, progress: n }) {
  const r = t !== "done" && t !== "failed";
  return /* @__PURE__ */ b("svg", { className: `file-gauge-pip ${t}`, width: "8", height: "8", viewBox: "0 0 8 8", "aria-hidden": "true", children: [
    t === "done" && /* @__PURE__ */ i("circle", { className: "dot", cx: "4", cy: "4", r: "3.5" }),
    r && /* @__PURE__ */ i("circle", { className: "ring", cx: "4", cy: "4", r: P }),
    (t === "active" || t === "partial") && n !== void 0 && n > 0 && /* @__PURE__ */ i("circle", { className: "fill", cx: "4", cy: "4", r: P, strokeDasharray: `${n * D} ${D}`, transform: "rotate(-90 4 4)" }),
    t === "skipped" && /* @__PURE__ */ i("line", { className: "slash", x1: "1.6", y1: "6.4", x2: "6.4", y2: "1.6" }),
    t === "failed" && /* @__PURE__ */ i("path", { className: "cross", d: "M1.5 1.5 6.5 6.5 M6.5 1.5 1.5 6.5" })
  ] });
}
const ue = z(function({ label: n = !1, name: r, tabIndex: f, ...x }) {
  const o = ie(x), [d, s] = L("off"), [u, k] = L(null), y = C(null), p = C(null), v = G(), m = d !== "off", l = () => s("off");
  W(() => {
    var B, I;
    if (!m) {
      k(null);
      return;
    }
    const e = (B = y.current) == null ? void 0 : B.getBoundingClientRect(), a = (I = p.current) == null ? void 0 : I.getBoundingClientRect();
    if (!e || !a)
      return;
    const c = a.width, w = a.height, g = e.bottom + 6, $ = g + w > window.innerHeight ? e.top - 6 - w : g;
    k({
      left: O(e.left, E, Math.max(E, window.innerWidth - c - E)),
      top: O($, E, Math.max(E, window.innerHeight - w - E))
    });
  }, [m]), T(() => {
    var w;
    if (!m)
      return;
    const e = (g) => {
      g.key === "Escape" && (g.stopPropagation(), g.preventDefault(), l());
    };
    window.addEventListener("keydown", e, !0), window.addEventListener("scroll", l, !0);
    const a = (w = y.current) == null ? void 0 : w.getRootNode(), c = a && "host" in a ? a : null;
    return c == null || c.addEventListener("scroll", l, !0), () => {
      window.removeEventListener("keydown", e, !0), window.removeEventListener("scroll", l, !0), c == null || c.removeEventListener("scroll", l, !0);
    };
  }, [m]), T(() => {
    if (d !== "pinned")
      return;
    const e = (a) => {
      const c = a.composedPath();
      !c.includes(y.current) && !c.includes(p.current) && l();
    };
    return document.addEventListener("pointerdown", e, !0), () => document.removeEventListener("pointerdown", e, !0);
  }, [d]);
  const h = () => {
    var a;
    const e = (a = y.current) == null ? void 0 : a.getRootNode();
    return e && "host" in e ? e : document.body;
  }, N = (e) => e.stopPropagation();
  return /* @__PURE__ */ b(
    "button",
    {
      ref: y,
      type: "button",
      className: `file-gauge tone-${o.tone}`,
      "data-outcome": o.outcome,
      "aria-label": r ? `${r}: ${R(o)}` : R(o),
      tabIndex: f,
      "aria-describedby": m ? v : void 0,
      onMouseEnter: () => s((e) => e === "off" ? "hover" : e),
      onMouseLeave: () => s((e) => e === "hover" ? "off" : e),
      onFocus: () => s((e) => e === "off" ? "hover" : e),
      onBlur: l,
      onClick: (e) => {
        e.stopPropagation(), s((a) => a === "pinned" ? "off" : "pinned");
      },
      onDoubleClick: N,
      onMouseDown: N,
      children: [
        /* @__PURE__ */ i("span", { className: "file-gauge-pips", children: o.stages.map((e) => /* @__PURE__ */ i(K, { state: e.state, progress: e.progress }, e.key)) }),
        /* @__PURE__ */ i("span", { className: `file-gauge-badge ${o.searchable.fullText}`, "aria-hidden": "true", children: "F" }),
        /* @__PURE__ */ i("span", { className: `file-gauge-badge ${o.searchable.vector}`, "aria-hidden": "true", children: "V" }),
        n && /* @__PURE__ */ i("span", { className: "file-gauge-label", "aria-hidden": "true", children: o.label }),
        m && H(
          /* @__PURE__ */ b(
            "span",
            {
              ref: p,
              role: "tooltip",
              id: v,
              className: `file-gauge-card tone-${o.tone}`,
              style: u ?? { left: 0, top: 0, visibility: "hidden" },
              onClick: N,
              onDoubleClick: N,
              onMouseDown: (e) => {
                e.stopPropagation(), e.preventDefault();
              },
              children: [
                r && /* @__PURE__ */ i("span", { className: "file-gauge-card-name", children: r }),
                o.stages.map((e) => /* @__PURE__ */ b("span", { className: `file-gauge-card-row ${e.state}`, title: e.explain, children: [
                  /* @__PURE__ */ i(K, { state: e.state, progress: e.progress }),
                  /* @__PURE__ */ i("span", { className: "file-gauge-card-stage", children: e.name }),
                  /* @__PURE__ */ i("span", { className: "file-gauge-card-detail", children: e.state === "skipped" ? "skipped" : e.detail ?? "" })
                ] }, e.key)),
                /* @__PURE__ */ i("span", { className: "file-gauge-card-hint", children: o.hint })
              ]
            }
          ),
          h()
        )
      ]
    }
  );
});
function he({ options: t = [], value: n, onChange: r, name: f, label: x }) {
  return /* @__PURE__ */ i("div", { className: "choice-list", role: "radiogroup", "aria-label": x, children: t.map((o) => {
    const d = o.value === n;
    return /* @__PURE__ */ b("label", { className: "choice" + (d ? " selected" : "") + (o.disabled ? " disabled" : ""), children: [
      /* @__PURE__ */ b("span", { className: "choice-text", children: [
        /* @__PURE__ */ i("span", { className: "choice-title", children: o.label }),
        o.description && /* @__PURE__ */ i("span", { className: "choice-desc", children: o.description })
      ] }),
      /* @__PURE__ */ i(
        "input",
        {
          type: "radio",
          className: "choice-radio",
          name: f,
          value: o.value,
          checked: d,
          disabled: o.disabled,
          onChange: () => r == null ? void 0 : r(o.value)
        }
      )
    ] }, o.value);
  }) });
}
function fe({ actions: t = [], label: n = "Actions" }) {
  const [r, f] = L(!1), x = C(null);
  return T(() => {
    if (!r)
      return;
    const o = (s) => {
      (s.composedPath ? s.composedPath() : []).includes(x.current) || f(!1);
    }, d = (s) => {
      s.key === "Escape" && f(!1);
    };
    return document.addEventListener("click", o), document.addEventListener("keydown", d), () => {
      document.removeEventListener("click", o), document.removeEventListener("keydown", d);
    };
  }, [r]), /* @__PURE__ */ b("div", { className: "row-actions", ref: x, children: [
    /* @__PURE__ */ i(
      "button",
      {
        type: "button",
        className: "row-actions-trigger",
        "aria-haspopup": "menu",
        "aria-expanded": r,
        "aria-label": n,
        onClick: () => f((o) => !o),
        children: "⋯"
      }
    ),
    r && /* @__PURE__ */ i("div", { className: "row-actions-menu", role: "menu", children: t.map((o, d) => /* @__PURE__ */ i(
      "button",
      {
        type: "button",
        role: "menuitem",
        className: "row-actions-item" + (o.tone ? " " + o.tone : ""),
        onClick: () => {
          f(!1), o.onSelect();
        },
        children: o.label
      },
      d
    )) })
  ] });
}
export {
  he as ChoiceList,
  ue as FileGauge,
  ce as PasswordField,
  fe as RowActionMenu,
  de as StatusCard,
  le as Tabs,
  Y as depthTarget,
  ie as fileGauge,
  R as gaugeName,
  Z as passwordStrength
};
