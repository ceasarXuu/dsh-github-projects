/* dsh-github-projects — page behaviour
   1. the one live thing: the Writes switch
   2. the entrance layer (one rise per part, staggered)
   3. copy the install command                                                  */
(function () {
  "use strict";

  var root = document.documentElement;
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ------------------------------------------------ 1 · the switch */
  var cb = document.getElementById("writes");
  var state = document.getElementById("tstate");

  function setMode(on) {
    root.dataset.mode = on ? "on" : "off";
    if (cb) cb.checked = on;
    if (state) state.textContent = "allowWrites: " + (on ? "true" : "false");
  }

  if (cb) {
    cb.addEventListener("change", function () {
      setMode(cb.checked);
    });
    /* the markup ships the read-only table emphasis; sync the label on load */
    setMode(cb.checked);
  }

  /* ------------------------------------------------ 2 · entrance */
  var SEL = [
    ".hero h1", ".hero .lead", ".doors", ".hero-act",
    ".head h2", ".head p",
    ".plate-row", ".toggle-row", ".cmp", ".after",
    ".exchanges > li",
    ".qa dt", ".qa dd",
    ".cta h2", ".cta .call", ".cta > p"
  ].join(",");

  var parts = [].slice.call(document.querySelectorAll(SEL));
  if (!parts.length) return;

  if (reduce) return; /* no .rise is added, so everything stays visible */

  /* Stagger inside each section, computed once. */
  parts.forEach(function (el) {
    var scope = el.closest("section") || document.body;
    var group = [].slice.call(scope.querySelectorAll(SEL));
    el.style.transitionDelay = Math.min(group.indexOf(el), 6) * 70 + "ms";
    el.classList.add("rise");
  });

  /* A scroll pass, not an observer: an instant jump (a screenshot tool, a
     keyboard "End", a restored scroll position) still reveals everything the
     reader has passed. Nothing is ever left transparent behind them. */
  var queued = false;

  function pass() {
    queued = false;
    var vh = window.innerHeight;
    for (var i = 0; i < parts.length; i++) {
      var el = parts[i];
      if (el.classList.contains("in")) continue;
      var r = el.getBoundingClientRect();
      if (r.top < vh * 0.94 && r.bottom > -vh * 0.5) el.classList.add("in");
    }
  }

  function onScroll() {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(pass);
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  window.addEventListener("load", onScroll);
  pass();

  /* ------------------------------------------------ 3 · copy */
  [].slice.call(document.querySelectorAll("[data-copy]")).forEach(function (btn) {
    btn.addEventListener("click", function () {
      var src = document.getElementById(btn.getAttribute("data-copy"));
      if (!src) return;
      var text = src.textContent.trim();
      var done = function () {
        var prev = btn.textContent;
        btn.textContent = "Copied";
        btn.classList.add("done");
        window.setTimeout(function () {
          btn.textContent = prev;
          btn.classList.remove("done");
        }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () {});
      }
    });
  });
})();
