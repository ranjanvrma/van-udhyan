/* =====================================================================
   Verdant Atlas FX
   - Ambient particle+vine canvas (pure 2D, lightweight)
   - 3D tilt on KPI/zone/export cards (mouse-driven perspective)
   - Scroll-reveal via IntersectionObserver (adds [data-reveal].visible)
   - Magnetic hover on primary buttons (position-aware shine origin)
   - MutationObserver so dynamically-added cards also get the FX
   Honours prefers-reduced-motion. Zero external deps.
   ===================================================================== */
(() => {
    "use strict";

    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const isMobile = window.matchMedia("(max-width: 1024px)").matches;

    /* ----------------- 1. AMBIENT CANVAS: particles + vines ------------------ */
    (function ambientCanvas() {
        if (prefersReduced) return;
        const canvas = document.getElementById("fx-canvas");
        if (!canvas) return;

        const ctx = canvas.getContext("2d", { alpha: true });
        let w = 0, h = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
        let particles = [];
        let rafId = null;
        let lastT = 0;
        const PCOUNT = isMobile ? 32 : 70;

        function resize() {
            w = window.innerWidth;
            h = window.innerHeight;
            canvas.width = w * dpr;
            canvas.height = h * dpr;
            canvas.style.width = w + "px";
            canvas.style.height = h + "px";
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }

        function spawn(n) {
            for (let i = 0; i < n; i++) {
                particles.push({
                    x: Math.random() * w,
                    y: Math.random() * h,
                    vx: (Math.random() - 0.5) * 0.25,
                    vy: -0.1 - Math.random() * 0.25,
                    r: 0.6 + Math.random() * 1.6,
                    life: Math.random() * 1,
                    hue: 140 + Math.random() * 40,  // 140..180: leaf→teal
                    alpha: 0.3 + Math.random() * 0.5,
                });
            }
        }

        function step(t) {
            const dt = Math.min(32, t - lastT) || 16;
            lastT = t;
            ctx.clearRect(0, 0, w, h);

            // vine connections
            ctx.lineWidth = 0.6;
            for (let i = 0; i < particles.length; i++) {
                const a = particles[i];
                for (let j = i + 1; j < particles.length; j++) {
                    const b = particles[j];
                    const dx = a.x - b.x, dy = a.y - b.y;
                    const d2 = dx * dx + dy * dy;
                    if (d2 < 10000) {
                        const op = (1 - d2 / 10000) * 0.14;
                        ctx.strokeStyle = `hsla(${(a.hue + b.hue) / 2}, 70%, 55%, ${op})`;
                        ctx.beginPath();
                        ctx.moveTo(a.x, a.y);
                        ctx.lineTo(b.x, b.y);
                        ctx.stroke();
                    }
                }
            }

            // particles
            for (const p of particles) {
                p.x += p.vx * dt * 0.06;
                p.y += p.vy * dt * 0.06;
                p.life += 0.004;
                if (p.y < -20 || p.x < -20 || p.x > w + 20) {
                    p.x = Math.random() * w;
                    p.y = h + 10;
                    p.life = 0;
                }
                const a = p.alpha * (0.6 + 0.4 * Math.sin(p.life * 2));
                ctx.fillStyle = `hsla(${p.hue}, 80%, 60%, ${a})`;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
                ctx.fill();
            }

            rafId = requestAnimationFrame(step);
        }

        resize();
        spawn(PCOUNT);
        rafId = requestAnimationFrame(step);
        window.addEventListener("resize", () => {
            resize();
        });

        // pause when tab is hidden
        document.addEventListener("visibilitychange", () => {
            if (document.hidden) {
                if (rafId) cancelAnimationFrame(rafId);
                rafId = null;
            } else if (!rafId) {
                lastT = 0;
                rafId = requestAnimationFrame(step);
            }
        });
    })();

    /* ----------------- 2. 3D TILT on cards ------------------ */
    (function tiltCards() {
        if (prefersReduced || isMobile) return;
        const TILT_SELECTOR = ".kpi-card, .zone-card, .export-card";
        const MAX_TILT = 6; // degrees

        function attach(el) {
            if (el.dataset.tiltBound) return;
            el.dataset.tiltBound = "1";
            el.style.willChange = "transform";
            let raf = null;

            el.addEventListener("mousemove", (e) => {
                const rect = el.getBoundingClientRect();
                const cx = rect.left + rect.width / 2;
                const cy = rect.top + rect.height / 2;
                const dx = (e.clientX - cx) / (rect.width / 2);
                const dy = (e.clientY - cy) / (rect.height / 2);
                const rx = (-dy * MAX_TILT).toFixed(2);
                const ry = (dx * MAX_TILT).toFixed(2);
                if (raf) cancelAnimationFrame(raf);
                raf = requestAnimationFrame(() => {
                    el.style.transform = `translateY(-6px) perspective(900px) rotateX(${rx}deg) rotateY(${ry}deg)`;
                });
                el.style.setProperty("--mx", ((e.clientX - rect.left) / rect.width * 100) + "%");
                el.style.setProperty("--my", ((e.clientY - rect.top) / rect.height * 100) + "%");
            });

            el.addEventListener("mouseleave", () => {
                if (raf) cancelAnimationFrame(raf);
                el.style.transform = "";
            });
        }

        function scan() {
            document.querySelectorAll(TILT_SELECTOR).forEach(attach);
        }
        scan();

        // Re-bind after dynamic content loads
        const mo = new MutationObserver(() => scan());
        mo.observe(document.body, { childList: true, subtree: true });
    })();

    /* ----------------- 3. SCROLL REVEAL ------------------ */
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
        }, { threshold: 0.1, rootMargin: "0px 0px -40px 0px" });

        // Auto-mark common containers so the designer doesn't have to touch HTML
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
        const mo = new MutationObserver(() => mark());
        mo.observe(document.body, { childList: true, subtree: true });
    })();

    /* ----------------- 4. MAGNETIC BUTTONS (shine origin) ------------------ */
    (function magneticButtons() {
        if (prefersReduced) return;
        const SEL = ".btn-primary, .auth-btn, .source-badge";

        function bind(el) {
            if (el.dataset.magneticBound) return;
            el.dataset.magneticBound = "1";
            el.addEventListener("mousemove", (e) => {
                const r = el.getBoundingClientRect();
                el.style.setProperty("--mx", ((e.clientX - r.left) / r.width * 100) + "%");
                el.style.setProperty("--my", ((e.clientY - r.top) / r.height * 100) + "%");
            });
        }

        function scan() { document.querySelectorAll(SEL).forEach(bind); }
        scan();
        const mo = new MutationObserver(scan);
        mo.observe(document.body, { childList: true, subtree: true });
    })();
})();
