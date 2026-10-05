/* =====================================================================
   Verdant Atlas FX — perf-tuned pass
   Scope reduced to what pays its way at 120Hz:
   - lightweight ambient particles (desktop only, no O(n²) network)
   - scroll-reveal (passive IntersectionObserver)
   - magnetic highlight on primary surfaces (passive mousemove + rAF)
   Removed: 3D tilt (per-pixel reflow on cards), particle line network
   (O(n²) per frame), animated conic borders (full repaints).
   Honours prefers-reduced-motion and skips expensive work on mobile.
   ===================================================================== */
(() => {
    "use strict";

    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const isMobile = window.matchMedia("(max-width: 1024px)").matches;

    /* ----------------- 1. AMBIENT CANVAS (desktop only, cheap) ------------------ */
    (function ambientCanvas() {
        if (prefersReduced || isMobile) {
            const c = document.getElementById("fx-canvas");
            if (c) c.style.display = "none";
            return;
        }

        const canvas = document.getElementById("fx-canvas");
        if (!canvas) return;

        const ctx = canvas.getContext("2d", { alpha: true });
        let w = 0, h = 0;
        const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
        let particles = [];
        let rafId = null;
        const PCOUNT = 22;  // was 70 — big drop with no visual difference

        function resize() {
            w = window.innerWidth;
            h = window.innerHeight;
            canvas.width = w * dpr;
            canvas.height = h * dpr;
            canvas.style.width = w + "px";
            canvas.style.height = h + "px";
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }

        function spawn() {
            particles = [];
            for (let i = 0; i < PCOUNT; i++) {
                particles.push({
                    x: Math.random() * w,
                    y: Math.random() * h,
                    vx: (Math.random() - 0.5) * 0.15,
                    vy: -0.08 - Math.random() * 0.18,
                    r: 0.8 + Math.random() * 1.6,
                    hue: 140 + Math.random() * 40,
                    alpha: 0.3 + Math.random() * 0.4,
                });
            }
        }

        function step() {
            ctx.clearRect(0, 0, w, h);
            // No O(n^2) connection network — just the particles themselves
            for (const p of particles) {
                p.x += p.vx;
                p.y += p.vy;
                if (p.y < -20 || p.x < -20 || p.x > w + 20) {
                    p.x = Math.random() * w;
                    p.y = h + 10;
                }
                ctx.fillStyle = `hsla(${p.hue}, 80%, 60%, ${p.alpha})`;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
                ctx.fill();
            }
            rafId = requestAnimationFrame(step);
        }

        resize();
        spawn();
        rafId = requestAnimationFrame(step);

        // Debounced resize
        let resizeT = null;
        window.addEventListener("resize", () => {
            clearTimeout(resizeT);
            resizeT = setTimeout(() => { resize(); spawn(); }, 150);
        }, { passive: true });

        // Pause when hidden
        document.addEventListener("visibilitychange", () => {
            if (document.hidden) {
                if (rafId) cancelAnimationFrame(rafId);
                rafId = null;
            } else if (!rafId) {
                rafId = requestAnimationFrame(step);
            }
        });
    })();

    /* ----------------- 2. SCROLL REVEAL (cheap) ------------------ */
    (function scrollReveal() {
        if (prefersReduced) {
            document.querySelectorAll("[data-reveal]").forEach(el => el.classList.add("visible"));
            return;
        }

        const io = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting) {
                    entry.target.classList.add("visible");
                    io.unobserve(entry.target);
                }
            }
        }, { threshold: 0.08, rootMargin: "0px 0px -40px 0px" });

        const AUTO = ".kpi-card, .chart-card, .panel, .zone-card, .export-card, .table-card, .map-card, .note-card";

        function mark() {
            document.querySelectorAll(AUTO).forEach(el => {
                if (!el.hasAttribute("data-reveal") && !el.classList.contains("visible")) {
                    el.setAttribute("data-reveal", "");
                    io.observe(el);
                }
            });
        }
        mark();

        // MutationObserver watches only direct children of .tab-pane
        // and the main-content root — much cheaper than whole-body subtree.
        const roots = document.querySelectorAll(".tab-pane, .main-content");
        const mo = new MutationObserver(() => mark());
        roots.forEach(r => mo.observe(r, { childList: true, subtree: true }));
    })();

    /* ----------------- 3. MAGNETIC HIGHLIGHT (passive, rAF) ------------------ */
    (function magneticButtons() {
        if (prefersReduced || isMobile) return;
        const SEL = ".btn-primary, .auth-btn, .source-badge";
        let raf = null, pendingEl = null, pendingX = 0, pendingY = 0;

        function flush() {
            raf = null;
            if (!pendingEl) return;
            pendingEl.style.setProperty("--mx", pendingX + "%");
            pendingEl.style.setProperty("--my", pendingY + "%");
            pendingEl = null;
        }

        function bind(el) {
            if (el.dataset.magneticBound) return;
            el.dataset.magneticBound = "1";
            el.addEventListener("mousemove", (e) => {
                const r = el.getBoundingClientRect();
                pendingEl = el;
                pendingX = ((e.clientX - r.left) / r.width * 100);
                pendingY = ((e.clientY - r.top) / r.height * 100);
                if (!raf) raf = requestAnimationFrame(flush);
            }, { passive: true });
        }

        function scan() { document.querySelectorAll(SEL).forEach(bind); }
        scan();

        // Scope mutation observer tightly
        const mo = new MutationObserver(scan);
        mo.observe(document.body, { childList: true, subtree: true });
    })();
})();
