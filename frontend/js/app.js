/**
 * Single Page Application (SPA) Controller Engine
 * Handles navigation tabs, Leaflet GIS map, Chart.js KPI charts, species search, observation filters,
 * pagination, observation details & species review, plantation management modals, dataset export
 * downloads, and password-protected editing.
 */

document.addEventListener("DOMContentLoaded", () => {
    App.init();
});

const App = {
    currentTab: "overview",
    leafletMap: null,
    mapLayerGroup: null,
    charts: {},

    // State Variables
    obsPage: 1,
    obsLimit: 15,
    obsFilters: { source: "", zone: "", quality_grade: "", species: "" },
    
    speciesPage: 1,
    speciesLimit: 15,
    speciesSearch: "",

    plantedPage: 1,
    plantedLimit: 10,
    plantedFilters: { status: "", zone: "", species: "" },
    editingPlantId: null,

    // Phase 15 Auth Callback Holder
    pendingAction: null,

    async init() {
        this.setupNavigation();
        this.setupModalDismissal();
        this.setupPhotoGpsListeners();
        this.updateAuthStatusUI();
        await this.checkBackendHealth();

        // Open the tab named in the URL (e.g. #map), otherwise the overview
        const initialTab = (location.hash || "").replace("#", "");
        if (initialTab && initialTab !== "overview" && document.getElementById(`tab-${initialTab}`)) {
            await this.switchTab(initialTab);
        } else {
            try {
                await this.loadOverview();
            } catch (err) {
                this.showErrorBanner(`Could not load the overview: ${err.message}`);
            }
        }
    },

    // =====================================================================
    // UI helpers
    // =====================================================================

    // Escapes user- or data-provided text before inserting it as HTML
    esc(value) {
        if (value === null || value === undefined) return "";
        return String(value)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    },

    // Non-blocking notification in the bottom-right corner
    notify(message, type = "success", timeoutMs = 4500) {
        const container = document.getElementById("toast-container");
        if (!container) { alert(message); return; }
        const toast = document.createElement("div");
        toast.className = `toast ${type}`;
        toast.textContent = message;
        container.appendChild(toast);
        setTimeout(() => {
            toast.classList.add("leaving");
            setTimeout(() => toast.remove(), 300);
        }, timeoutMs);
    },

    photoSrc(photoUrl) {
        if (!photoUrl) return "";
        if (/^https?:\/\//i.test(photoUrl)) return photoUrl;
        return window.APP_CONFIG.getEndpoint(photoUrl);
    },

    // Small cached preview for uploaded photos (falls back to the original for other URLs)
    thumbSrc(photoUrl) {
        const m = /^\/uploads\/(upload_[A-Za-z0-9_]+\.(jpg|jpeg|png|webp))$/i.exec(photoUrl || "");
        return m ? window.APP_CONFIG.getEndpoint(`/thumbs/${m[1]}`) : this.photoSrc(photoUrl);
    },

    zoneLabel(zone) {
        if (!zone) return '<span class="zone-text outside">Outside zones</span>';
        const cls = { "ZONE A": "zone-a", "ZONE B": "zone-b", "ZONE C": "zone-c" }[zone.toUpperCase()] || "";
        return `<span class="zone-text ${cls}">${this.esc(zone)}</span>`;
    },

    sourceLabel(source) {
        if (source === "NGO / New Upload") return '<span class="pill pill-orange">RSWF field upload</span>';
        if (source === "iNaturalist") return '<span class="pill pill-green">iNaturalist</span>';
        return `<span class="pill pill-grey">${this.esc(source || "Unknown")}</span>`;
    },

    // Status badge: review state for RSWF uploads, quality grade for iNaturalist records
    statusBadge(o) {
        if (o.source === "NGO / New Upload") {
            const map = {
                verified: ["verified", "✓ Verified"],
                corrected: ["corrected", "✓ Corrected"],
                ai_suggested: ["ai", "AI suggested"],
                needs_review: ["review", "Needs review"]
            };
            const [cls, label] = map[o.identification_status] || (o.scientific_name ? ["review", "Unconfirmed"] : ["review", "Needs ID"]);
            return `<span class="id-badge ${cls}">${label}</span>`;
        }
        const grades = { research: ["verified", "Research grade"], needs_id: ["review", "Needs ID"], casual: ["reference", "Casual"] };
        const [cls, label] = grades[o.quality_grade] || ["reference", this.esc(o.quality_grade || "—")];
        return `<span class="id-badge ${cls}">${label}</span>`;
    },

    // Collects every page of a paginated list endpoint (the API returns at most 200 per page)
    async fetchAllPages(fetchPage, pageSize = 200, maxPages = 50) {
        const all = [];
        for (let page = 1; page <= maxPages; page++) {
            const res = await fetchPage({ page, limit: pageSize });
            all.push(...(res.data || []));
            if (!res.total_pages || page >= res.total_pages) break;
        }
        return all;
    },

    // Swaps a broken <img> (photo file missing on the server) for a placeholder box
    replaceMissingPhoto(el, className, text) {
        const box = document.createElement("div");
        box.className = className;
        box.title = "Photo file missing";
        box.textContent = text;
        el.replaceWith(box);
    },

    isAwaitingReview(o) {
        return o.source === "NGO / New Upload" && !["verified", "corrected"].includes(o.identification_status);
    },

    setupModalDismissal() {
        const closers = {
            "obs-detail-modal": () => this.closeObservationDetail(),
            "plant-modal": () => this.closePlantModal(),
            "ngo-obs-modal": () => this.closeNgoObsModal(),
            "upload-photo-modal": () => this.closeUploadPhotoModal(),
            "plant-monitoring-modal": () => this.closeMonitoringModal(),
            "plant-history-modal": () => this.closePlantHistoryModal(),
            "ngo-auth-modal": () => this.closeAuthModal()
        };
        // Click on the dark backdrop (outside the card) closes the dialog
        Object.entries(closers).forEach(([id, close]) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener("mousedown", (e) => { if (e.target === el) close(); });
        });
        // Escape closes the top-most open dialog
        document.addEventListener("keydown", (e) => {
            if (e.key !== "Escape") return;
            const open = Object.keys(closers).filter(id => {
                const el = document.getElementById(id);
                return el && el.style.display !== "none";
            });
            if (open.length) closers[open[open.length - 1]]();
        });
    },

    setupPhotoGpsListeners() {
        const plantPhotoInput = document.getElementById("form-plant-photo-file");
        if (plantPhotoInput) {
            plantPhotoInput.addEventListener("change", async (e) => {
                if (!e.target.files || e.target.files.length === 0) return;
                const badge = document.getElementById("plant-photo-gps-badge");
                if (badge) {
                    badge.textContent = "⏳ Checking photo for GPS / geotag...";
                    badge.style.display = "block";
                    badge.style.color = "#60a5fa";
                }
                try {
                    const info = await ApiService.inspectPhoto(e.target.files[0]);
                    if (info.gps_available && info.latitude && info.longitude) {
                        const latInput = document.getElementById("form-latitude");
                        const lngInput = document.getElementById("form-longitude");
                        const zoneInput = document.getElementById("form-zone-code");
                        if (latInput && !latInput.value) latInput.value = info.latitude;
                        if (lngInput && !lngInput.value) lngInput.value = info.longitude;
                        if (zoneInput && !zoneInput.value && info.zone && info.zone !== "Outside Active Zones") zoneInput.value = info.zone;
                        if (badge) {
                            badge.innerHTML = `✓ ${info.gps_description} (${info.latitude.toFixed(6)}, ${info.longitude.toFixed(6)})`;
                            badge.style.color = "#34d399";
                        }
                    } else if (badge) {
                        badge.innerHTML = "ℹ️ No GPS metadata or visible geotag found in this photo.";
                        badge.style.color = "#94a3b8";
                    }
                } catch (err) {
                    if (badge) {
                        badge.innerHTML = `⚠️ Notice: ${err.message}`;
                        badge.style.color = "#f87171";
                    }
                }
            });
        }

        const ngoPhotoInput = document.getElementById("ngo-photo-file");
        if (ngoPhotoInput) {
            ngoPhotoInput.addEventListener("change", async (e) => {
                if (!e.target.files || e.target.files.length === 0) return;
                const badge = document.getElementById("ngo-photo-gps-badge");
                if (badge) {
                    badge.textContent = "⏳ Checking photo for GPS / geotag...";
                    badge.style.display = "block";
                    badge.style.color = "#60a5fa";
                }
                try {
                    const info = await ApiService.inspectPhoto(e.target.files[0]);
                    if (info.gps_available && info.latitude && info.longitude) {
                        const latInput = document.getElementById("ngo-latitude");
                        const lngInput = document.getElementById("ngo-longitude");
                        if (latInput && !latInput.value) latInput.value = info.latitude;
                        if (lngInput && !lngInput.value) lngInput.value = info.longitude;
                        if (badge) {
                            badge.innerHTML = `✓ ${info.gps_description} (${info.latitude.toFixed(6)}, ${info.longitude.toFixed(6)})`;
                            badge.style.color = "#34d399";
                        }
                    } else if (badge) {
                        badge.innerHTML = "ℹ️ No GPS metadata or visible geotag found in this photo.";
                        badge.style.color = "#94a3b8";
                    }
                } catch (err) {
                    if (badge) {
                        badge.innerHTML = `⚠️ Notice: ${err.message}`;
                        badge.style.color = "#f87171";
                    }
                }
            });
        }
    },

    // =====================================================================
    // Phase 15 — Password-Protected Auth UI Handlers
    // =====================================================================

    updateAuthStatusUI() {
        const btn = document.getElementById("ngo-auth-status-btn");
        if (!btn) return;
        const pass = ApiService.getNgoPassword();
        if (pass) {
            btn.textContent = "🔓 Editing unlocked · Lock";
            btn.classList.add("unlocked");
            btn.title = "RSWF editing is unlocked in this browser. Click to lock again.";
        } else {
            btn.textContent = "🔒 View only · Unlock editing";
            btn.classList.remove("unlocked");
            btn.title = "RSWF staff can unlock editing with the admin password";
        }
    },

    toggleAuthSession() {
        const pass = ApiService.getNgoPassword();
        if (pass) {
            ApiService.clearNgoPassword();
            this.updateAuthStatusUI();
            this.notify("Editing locked. You are now in view-only mode.");
        } else {
            this.openAuthModal(null);
        }
    },

    requireAuth(actionCallback) {
        if (ApiService.getNgoPassword()) {
            actionCallback();
        } else {
            this.openAuthModal(actionCallback);
        }
    },

    openAuthModal(actionCallback = null) {
        this.pendingAction = actionCallback;
        const passInput = document.getElementById("ngo-auth-password");
        const errDiv = document.getElementById("auth-error-msg");
        if (passInput) passInput.value = "";
        if (errDiv) errDiv.style.display = "none";
        document.getElementById("ngo-auth-modal").style.display = "flex";
        if (passInput) passInput.focus();
    },

    closeAuthModal() {
        this.pendingAction = null;
        document.getElementById("ngo-auth-modal").style.display = "none";
    },

    handleAuthSubmit(e) {
        e.preventDefault();
        const password = document.getElementById("ngo-auth-password").value;
        if (!password) return;

        ApiService.setNgoPassword(password);
        this.updateAuthStatusUI();
        document.getElementById("ngo-auth-modal").style.display = "none";

        if (this.pendingAction) {
            const act = this.pendingAction;
            this.pendingAction = null;
            act();
        }
    },

    setupNavigation() {
        document.querySelectorAll(".nav-item button").forEach(btn => {
            btn.addEventListener("click", async () => {
                const targetTab = btn.getAttribute("data-tab");
                if (targetTab === this.currentTab) return;
                await this.switchTab(targetTab);
            });
        });
        window.addEventListener("hashchange", () => {
            const tab = (location.hash || "#overview").replace("#", "");
            if (tab !== this.currentTab && document.getElementById(`tab-${tab}`)) this.switchTab(tab);
        });
    },

    async switchTab(targetTab) {
        document.querySelectorAll(".nav-item button").forEach(b => {
            b.classList.toggle("active", b.getAttribute("data-tab") === targetTab);
        });
        document.querySelectorAll(".tab-pane").forEach(pane => pane.classList.remove("active"));
        const targetPane = document.getElementById(`tab-${targetTab}`);
        if (targetPane) targetPane.classList.add("active");

        this.currentTab = targetTab;
        if (location.hash !== `#${targetTab}`) history.replaceState(null, "", `#${targetTab}`);
        const main = document.querySelector(".main-content");
        if (main) main.scrollTop = 0;
        await this.handleTabSwitch(targetTab);
    },

    async checkBackendHealth() {
        const badge = document.getElementById("backend-status-badge");
        try {
            await ApiService.getHealth();
            if (badge) {
                badge.classList.remove("offline");
                badge.innerHTML = `<span class="dot"></span> Live data connected`;
            }
            this.clearErrorBanner();
        } catch (err) {
            if (badge) {
                badge.classList.add("offline");
                badge.innerHTML = `<span class="dot"></span> Offline · retrying`;
            }
            this.showErrorBanner("Cannot reach the data server. Make sure the backend is running (http://localhost:8000), then press Retry.");
        }
    },

    async handleTabSwitch(tabName) {
        this.clearErrorBanner();
        try {
            switch (tabName) {
                case "overview":
                    await this.loadOverview();
                    break;
                case "map":
                    await this.loadMap();
                    break;
                case "species":
                    await this.loadSpecies();
                    break;
                case "observations":
                    await this.loadObservations();
                    break;
                case "zones":
                    await this.loadZones();
                    break;
                case "management":
                    await this.loadPlantedPlants();
                    break;
                case "export":
                    // Export UI static triggers ready
                    break;
            }
        } catch (err) {
            this.showErrorBanner(`Failed to load data for ${tabName}: ${err.message}`);
        }
    },

    // 1. Overview Tab Loader
    async loadOverview() {
        const stats = await ApiService.getStatisticsOverview();

        document.getElementById("kpi-total-obs").textContent = stats.total_observations.toLocaleString();
        document.getElementById("kpi-total-species").textContent = stats.unique_species_count.toLocaleString();
        
        const zoneCounts = stats.observations_by_zone || {};
        const activeZonesCount = (zoneCounts["ZONE A"] || 0) + (zoneCounts["ZONE B"] || 0) + (zoneCounts["ZONE C"] || 0);
        document.getElementById("kpi-inside-zones").textContent = activeZonesCount.toLocaleString();
        const pct = stats.total_observations ? Math.round((activeZonesCount / stats.total_observations) * 100) : 0;
        const insideSub = document.getElementById("kpi-inside-zones-sub");
        if (insideSub) insideSub.textContent = `${pct}% of all records, inside Zones A–C`;

        const coverage = document.getElementById("coverage-taxa-count");
        if (coverage) coverage.textContent = `The ${stats.unique_species_count.toLocaleString()}`;

        this.renderZoneChart(zoneCounts);
        this.renderSourceChart(stats.observations_by_source || {});
        await Promise.all([this.loadActionPriorities(), this.loadReviewCount()]);
    },

    // Number of RSWF field uploads whose species has not been confirmed or corrected yet
    async loadReviewCount() {
        const el = document.getElementById("kpi-review");
        if (!el) return;
        try {
            const records = await this.fetchAllPages((params) => ApiService.getObservations({ ...params, source: "NGO / New Upload" }));
            el.textContent = records.filter(o => this.isAwaitingReview(o)).length.toLocaleString();
        } catch (err) {
            el.textContent = "–";
        }
    },

    // Opens the Observations tab showing RSWF field uploads (the review queue)
    async openReviewQueue() {
        this.obsFilters = { source: "NGO / New Upload", zone: "", quality_grade: "", species: "" };
        this.obsPage = 1;
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
        set("obs-source-filter", "NGO / New Upload");
        set("obs-zone-filter", "");
        set("obs-quality-filter", "");
        set("obs-species-filter", "");
        await this.switchTab("observations");
    },

    async loadActionPriorities() {
        const container = document.getElementById("action-priorities-container");
        if (!container) return;

        try {
            const data = await ApiService.getAnalyticsActionPriorities();
            if (!data.priorities || data.priorities.length === 0) {
                container.innerHTML = `<div class="loading-text">No actions are suggested by the current data.</div>`;
                return;
            }

            const levels = {
                HIGH: { color: "#ef4444", bg: "rgba(239, 68, 68, 0.2)", label: "High priority" },
                MEDIUM: { color: "#f59e0b", bg: "rgba(245, 158, 11, 0.2)", label: "Medium priority" },
                LOW: { color: "#60a5fa", bg: "rgba(59, 130, 246, 0.2)", label: "Low priority" }
            };
            const areaName = (code) => code === "OUTSIDE_ACTIVE_ZONES" ? "Outside active zones" : code;
            const typeName = (t) => (t || "").replace(/_/g, " ").toLowerCase().replace(/^\w/, c => c.toUpperCase());

            container.innerHTML = data.priorities.map(p => {
                const lvl = levels[p.priority_level] || { color: "#10b981", bg: "rgba(16, 185, 129, 0.2)", label: typeName(p.priority_level) };
                return `
                    <div class="action-card" style="border-left-color:${lvl.color}">
                        <div class="action-card-head">
                            <b>${this.esc(areaName(p.area_code))}</b>
                            <span class="status-badge" style="background:${lvl.bg};color:${lvl.color}" title="${this.esc(lvl.label)}">${this.esc(typeName(p.priority_type))}</span>
                        </div>
                        <p><b>Why:</b> ${this.esc(p.reason)}</p>
                        <div class="action-do"><b>Suggested action:</b> ${this.esc(p.recommended_action)}</div>
                    </div>
                `;
            }).join("");
        } catch (err) {
            container.innerHTML = `<div style="color:#f87171;font-size:0.85rem">Could not load suggested actions: ${this.esc(err.message)}</div>`;
        }
    },

    renderZoneChart(zoneCounts) {
        const ctx = document.getElementById("chart-zone-breakdown");
        if (!ctx) return;

        if (this.charts.zoneChart) this.charts.zoneChart.destroy();

        this.charts.zoneChart = new Chart(ctx, {
            type: "bar",
            data: {
                labels: ["Zone A", "Zone B", "Zone C", "Outside Active Zones"],
                datasets: [{
                    label: "Observations",
                    data: [
                        zoneCounts["ZONE A"] || 0,
                        zoneCounts["ZONE B"] || 0,
                        zoneCounts["ZONE C"] || 0,
                        zoneCounts["OUTSIDE_ACTIVE_ZONES"] || 0
                    ],
                    backgroundColor: [
                        "rgba(16, 185, 129, 0.7)",
                        "rgba(59, 130, 246, 0.7)",
                        "rgba(139, 92, 246, 0.7)",
                        "rgba(249, 115, 22, 0.7)"
                    ],
                    borderColor: ["#10b981", "#3b82f6", "#8b5cf6", "#f97316"],
                    borderWidth: 1.5
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: (c) => ` ${c.parsed.y} observations` } }
                },
                scales: {
                    y: { beginAtZero: true, ticks: { color: "#94a3b8", precision: 0 }, grid: { color: "rgba(46,117,89,0.15)" } },
                    x: { ticks: { color: "#94a3b8" }, grid: { display: false } }
                }
            }
        });
    },

    renderSourceChart(sourceCounts) {
        const ctx = document.getElementById("chart-source-breakdown");
        if (!ctx) return;

        if (this.charts.sourceChart) this.charts.sourceChart.destroy();

        const friendly = { "iNaturalist": "iNaturalist (public records)", "NGO / New Upload": "RSWF field uploads" };
        const colors = { "iNaturalist": "#10b981", "NGO / New Upload": "#f97316" };
        const keys = Object.keys(sourceCounts);
        const values = Object.values(sourceCounts);

        this.charts.sourceChart = new Chart(ctx, {
            type: "doughnut",
            data: {
                labels: keys.map(k => friendly[k] || k),
                datasets: [{
                    data: values,
                    backgroundColor: keys.map((k, i) => colors[k] || ["#3b82f6", "#8b5cf6"][i % 2]),
                    borderColor: "#0c2019",
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: "58%",
                plugins: {
                    legend: { position: "bottom", labels: { color: "#e2e8f0", padding: 16 } },
                    tooltip: {
                        callbacks: {
                            label: (c) => {
                                const total = c.dataset.data.reduce((a, b) => a + b, 0) || 1;
                                return ` ${c.parsed} observations (${Math.round((c.parsed / total) * 100)}%)`;
                            }
                        }
                    }
                }
            }
        });
    },

    // 2. Interactive Leaflet GIS Map Loader
    async loadMap() {
        if (!this.leafletMap) {
            this.leafletMap = L.map("leaflet-map").setView([18.5195, 73.7800], 17);

            const street = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
                maxZoom: 19,
                attribution: "© OpenStreetMap contributors | RSWF NGO"
            }).addTo(this.leafletMap);
            const satellite = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
                maxZoom: 19,
                attribution: "Imagery © Esri | RSWF NGO"
            });

            this.mapLayers = {
                boundary: L.layerGroup().addTo(this.leafletMap),
                zones: L.layerGroup().addTo(this.leafletMap),
                inat: L.layerGroup().addTo(this.leafletMap),
                ngo: L.layerGroup().addTo(this.leafletMap),
                planted: L.layerGroup().addTo(this.leafletMap)
            };
            // Kept for compatibility with code that expects a single group
            this.mapLayerGroup = this.mapLayers.inat;

            L.control.layers(
                { "Street map": street, "Satellite": satellite },
                {
                    "Site boundary": this.mapLayers.boundary,
                    "Zones A / B / C": this.mapLayers.zones,
                    "iNaturalist records": this.mapLayers.inat,
                    "RSWF field uploads": this.mapLayers.ngo,
                    "RSWF planted plants": this.mapLayers.planted
                },
                { collapsed: window.innerWidth < 900 }
            ).addTo(this.leafletMap);
            L.control.scale({ imperial: false }).addTo(this.leafletMap);
        }

        Object.values(this.mapLayers).forEach(g => g.clearLayers());

        const [boundaryGeoJSON, zonesGeoJSONList, mapObsGeoJSON, plantedRes] = await Promise.all([
            ApiService.getGeography(),
            ApiService.getZones(),
            ApiService.getMapObservations(),
            this.fetchAllPages((params) => ApiService.getPlantedPlants(params)).then(data => ({ data })).catch(() => ({ data: [] }))
        ]);

        if (boundaryGeoJSON && boundaryGeoJSON.features) {
            const bLayer = L.geoJSON(boundaryGeoJSON, {
                style: { color: "#f59e0b", weight: 3, fillOpacity: 0.06, dashArray: "6, 6" }
            }).addTo(this.mapLayers.boundary);

            if (!this.mapFitted) {
                this.leafletMap.fitBounds(bLayer.getBounds(), { padding: [20, 20] });
                this.mapFitted = true;
            }
        }

        const colorMap = { "ZONE A": "#10b981", "ZONE B": "#3b82f6", "ZONE C": "#8b5cf6" };
        zonesGeoJSONList.forEach(z => {
            const zColor = colorMap[z.zone_code] || "#10b981";
            L.geoJSON(z.geometry, {
                style: { color: zColor, weight: 2, fillColor: zColor, fillOpacity: 0.22 }
            }).bindTooltip(this.esc(z.zone_code), { permanent: true, direction: "center", className: "zone-label-tooltip" })
              .addTo(this.mapLayers.zones);
        });

        const popupRow = (label, value) => value ? `<div class="popup-row"><b>${label}:</b> ${value}</div>` : "";

        if (mapObsGeoJSON && mapObsGeoJSON.features) {
            mapObsGeoJSON.features.forEach(feat => {
                const [lng, lat] = feat.geometry.coordinates;
                const props = feat.properties;
                const isNgo = props.source === "NGO / New Upload";

                const circleMarker = L.circleMarker([lat, lng], {
                    radius: isNgo ? 7 : 6,
                    fillColor: isNgo ? "#f97316" : "#10b981",
                    color: "#ffffff",
                    weight: 1,
                    opacity: 1,
                    fillOpacity: 0.85
                });

                const photo = props.photo_url ? this.photoSrc(props.photo_url) : "";
                const thumb = props.photo_url ? this.thumbSrc(props.photo_url) : "";
                const popupContent = `
                    <div>
                        <div class="popup-title">${this.esc(props.common_name || props.scientific_name || "Unidentified plant")}</div>
                        ${photo ? `<a href="${this.esc(photo)}" target="_blank" rel="noopener"><img class="popup-photo" src="${this.esc(thumb)}" alt="Observation photo" loading="lazy"></a>` : ""}
                        ${popupRow("Scientific name", props.scientific_name ? `<i>${this.esc(props.scientific_name)}</i>` : "Not identified yet")}
                        ${popupRow("Observed", this.esc(props.observed_on))}
                        ${popupRow("Observer", this.esc(props.observer))}
                        ${popupRow("Zone", this.esc(props.zone || "Outside active zones"))}
                        ${popupRow("Source", isNgo ? "RSWF field upload" : "iNaturalist")}
                        ${props.id ? `<div style="margin-top:6px"><button class="link-btn" onclick="App.openObservationDetail(${Number(props.id)})">View full details →</button></div>` : ""}
                    </div>
                `;

                circleMarker.bindPopup(popupContent, { maxWidth: 250 });
                (isNgo ? this.mapLayers.ngo : this.mapLayers.inat).addLayer(circleMarker);
            });
        }

        (plantedRes.data || []).forEach(p => {
            if (p.latitude == null || p.longitude == null) return;
            const statusColor = { Alive: "#10b981", Dead: "#ef4444", Unknown: "#f97316" }[p.status] || "#94a3b8";
            const marker = L.circleMarker([p.latitude, p.longitude], {
                radius: 7, fillColor: "#3b82f6", color: statusColor, weight: 2.5, opacity: 1, fillOpacity: 0.9
            });
            marker.bindPopup(`
                <div>
                    <div class="popup-title" style="color:#60a5fa">🌱 ${this.esc(p.common_name || p.scientific_name || p.plant_code)}</div>
                    ${popupRow("Plant code", this.esc(p.plant_code))}
                    ${popupRow("Scientific name", p.scientific_name ? `<i>${this.esc(p.scientific_name)}</i>` : "")}
                    ${popupRow("Planted", this.esc(p.planted_on))}
                    ${popupRow("Health", `<span style="color:${statusColor};font-weight:600">${this.esc(p.status)}</span>`)}
                    ${popupRow("Zone", this.esc(p.zone_code || "Outside active zones"))}
                </div>`, { maxWidth: 250 });
            this.mapLayers.planted.addLayer(marker);
        });

        setTimeout(() => this.leafletMap.invalidateSize(), 200);
    },

    // Opens the map and zooms to one zone
    async showZoneOnMap(zoneCode) {
        await this.switchTab("map");
        const zones = await ApiService.getZones();
        const z = zones.find(x => x.zone_code === zoneCode);
        if (z && this.leafletMap) this.leafletMap.fitBounds(L.geoJSON(z.geometry).getBounds(), { padding: [40, 40] });
    },

    // Opens the Observations tab filtered to one zone
    async showZoneObservations(zoneCode) {
        this.obsFilters = { source: "", zone: zoneCode, quality_grade: "", species: "" };
        this.obsPage = 1;
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
        set("obs-source-filter", "");
        set("obs-zone-filter", zoneCode);
        set("obs-quality-filter", "");
        set("obs-species-filter", "");
        await this.switchTab("observations");
    },

    // 3. Species Tab Loader
    async loadSpecies() {
        const searchInput = document.getElementById("species-search");
        if (searchInput && !searchInput.dataset.bound) {
            searchInput.dataset.bound = "true";
            searchInput.addEventListener("input", (e) => {
                this.speciesSearch = e.target.value;
                this.speciesPage = 1;
                this.loadSpecies();
            });
        }

        const res = await ApiService.getSpecies({
            page: this.speciesPage,
            limit: this.speciesLimit,
            species_name: this.speciesSearch
        });

        const tbody = document.getElementById("species-table-body");
        if (!tbody) return;

        if (res.data.length === 0) {
            tbody.innerHTML = `<tr class="empty-row"><td colspan="5">No species match “${this.esc(this.speciesSearch)}”.</td></tr>`;
            document.getElementById("species-page-info").textContent = "No results";
            document.getElementById("species-prev-btn").disabled = true;
            document.getElementById("species-next-btn").disabled = true;
            return;
        }

        const rankPill = (rank) => {
            const r = (rank || "species").toLowerCase();
            const cls = r === "species" ? "pill-green" : r === "genus" ? "pill-blue" : "pill-purple";
            return `<span class="pill ${cls}">${this.esc(r)}</span>`;
        };

        tbody.innerHTML = res.data.map(s => `
            <tr>
                <td class="faint">${s.id}</td>
                <td><b><i>${this.esc(s.scientific_name)}</i></b></td>
                <td>${s.common_name ? this.esc(s.common_name) : '<span class="faint">—</span>'}</td>
                <td>${rankPill(s.taxon_rank)}</td>
                <td><b>${s.record_count}</b> <span class="muted">${s.record_count === 1 ? "sighting" : "sightings"}</span></td>
            </tr>
        `).join("");

        document.getElementById("species-page-info").textContent = `Page ${res.page} of ${res.total_pages} · ${res.total_records} species & taxa`;
        document.getElementById("species-prev-btn").disabled = res.page <= 1;
        document.getElementById("species-next-btn").disabled = res.page >= res.total_pages;
    },

    changeSpeciesPage(delta) {
        this.speciesPage += delta;
        this.loadSpecies();
    },

    // 4. Observations Tab Loader
    async loadObservations() {
        const res = await ApiService.getObservations({
            page: this.obsPage,
            limit: this.obsLimit,
            source: this.obsFilters.source,
            zone: this.obsFilters.zone,
            quality_grade: this.obsFilters.quality_grade,
            species: this.obsFilters.species
        });

        const tbody = document.getElementById("obs-table-body");
        if (!tbody) return;

        if (res.data.length === 0) {
            tbody.innerHTML = `<tr class="empty-row"><td colspan="9">No observations match the current filters.</td></tr>`;
            document.getElementById("obs-page-info").textContent = "No results";
            document.getElementById("obs-prev-btn").disabled = true;
            document.getElementById("obs-next-btn").disabled = true;
            return;
        }

        tbody.innerHTML = res.data.map(o => {
            const photo = o.photo_url && o.source === "NGO / New Upload" ? this.thumbSrc(o.photo_url) : "";
            const thumb = photo
                ? `<img class="obs-thumb" src="${this.esc(photo)}" alt="" loading="lazy" onerror="App.replaceMissingPhoto(this, 'obs-thumb-empty', '–')">`
                : `<div class="obs-thumb-empty" title="${o.observation_url ? "Photo on iNaturalist" : "No photo"}">${o.observation_url ? "↗" : "–"}</div>`;
            return `
            <tr class="row-clickable" tabindex="0" onclick="App.openObservationDetail(${Number(o.id)})" onkeydown="if(event.key==='Enter')App.openObservationDetail(${Number(o.id)})" title="View details">
                <td class="faint">${o.id}</td>
                <td>${thumb}</td>
                <td>${o.scientific_name ? `<b><i>${this.esc(o.scientific_name)}</i></b>` : '<span class="muted">Not identified yet</span>'}</td>
                <td>${o.common_name ? this.esc(o.common_name) : '<span class="faint">—</span>'}</td>
                <td style="white-space:nowrap">${this.esc(o.observer || "—")}</td>
                <td style="white-space:nowrap">${this.esc(o.observed_on || "—")}</td>
                <td>${this.zoneLabel(o.zone)}</td>
                <td>${this.statusBadge(o)}</td>
                <td>${this.sourceLabel(o.source)}</td>
            </tr>`;
        }).join("");

        document.getElementById("obs-page-info").textContent = `Page ${res.page} of ${res.total_pages} · ${res.total_records} observations`;
        document.getElementById("obs-prev-btn").disabled = res.page <= 1;
        document.getElementById("obs-next-btn").disabled = res.page >= res.total_pages;
    },

    changeObsPage(delta) {
        this.obsPage += delta;
        this.loadObservations();
    },

    applyObsFilter(field, value) {
        this.obsFilters[field] = value;
        this.obsPage = 1;
        this.loadObservations();
    },

    // 5. Active Zones Tab Loader
    async loadZones() {
        const container = document.getElementById("zones-cards-container");
        if (!container) return;

        const [zones, analytics, coverage] = await Promise.all([
            ApiService.getZones(),
            ApiService.getAnalyticsZones().catch(() => ({ zones: {} })),
            ApiService.getAnalyticsCoverage().catch(() => null)
        ]);
        const stats = (analytics && analytics.zones) || {};
        const colors = { "ZONE A": "#10b981", "ZONE B": "#3b82f6", "ZONE C": "#8b5cf6" };

        container.innerHTML = zones.map(z => {
            const s = stats[z.zone_code] || {};
            const plants = s.plant_status_counts || {};
            const isActive = (z.status || "").toLowerCase().includes("active");
            const area = s.area_ha != null ? `${s.area_ha} ha (≈ ${Math.round(s.area_ha * 10000).toLocaleString()} m²)` : "";
            const code = this.esc(z.zone_code);
            return `
            <div class="zone-card" style="--zone-color:${colors[z.zone_code] || "#10b981"}">
                <div class="zone-card-head">
                    <h3>${code}</h3>
                    <span class="source-badge"><span class="dot"></span> ${isActive ? "Active" : this.esc(z.status)}</span>
                </div>
                <div class="zone-card-desc">RSWF planting and monitoring area${area ? ` · ${area}` : ""}.</div>
                <div class="zone-stats">
                    <div class="zone-stat"><b>${s.recorded_observations_count ?? "–"}</b><span>Observations</span></div>
                    <div class="zone-stat"><b>${s.unique_recorded_taxa_count ?? "–"}</b><span>Species &amp; taxa</span></div>
                    <div class="zone-stat"><b>${s.planted_plants_count ?? "–"}</b><span>Planted plants</span></div>
                    <div class="zone-stat"><b>${s.total_monitoring_visits_logged ?? "–"}</b><span>Health-check visits</span></div>
                </div>
                <div class="zone-health">
                    <span class="status-badge alive">${plants.Alive || 0} alive</span>
                    <span class="status-badge dead">${plants.Dead || 0} dead</span>
                    <span class="status-badge unknown">${plants.Unknown || 0} unknown</span>
                </div>
                <div class="zone-card-foot">
                    <span>Boundary mapped from the RSWF site survey</span>
                    <span style="display:flex;gap:0.9rem">
                        <button class="link-btn" onclick="App.showZoneOnMap('${code}')">View on map</button>
                        <button class="link-btn" onclick="App.showZoneObservations('${code}')">Observations →</button>
                    </span>
                </div>
            </div>`;
        }).join("");

        const note = document.getElementById("zones-coverage-note");
        if (note && coverage) {
            const a = coverage.active_zones_summary || {};
            const n = coverage.non_active_portion_summary || {};
            note.innerHTML = `📍 <b>Coverage:</b> the three zones cover ${a.area_ha ?? "–"} ha of the ${coverage.total_project_area_ha ?? "–"} ha site, and hold ${a.observation_percentage ?? "–"}% of all observations.
                The remaining ${n.area_ha ?? "–"} ha outside the zones has ${n.recorded_observations ?? "–"} records. Parts with no records are monitoring gaps, not areas without plants.`;
            note.style.display = "block";
        }
    },

    // 6. Data Management Tab Loader (Phase 7 CRUD)
    async loadPlantedPlants() {
        const res = await ApiService.getPlantedPlants({
            page: this.plantedPage,
            limit: this.plantedLimit,
            status: this.plantedFilters.status,
            zone: this.plantedFilters.zone,
            species: this.plantedFilters.species
        });

        const tbody = document.getElementById("planted-table-body");
        if (!tbody) return;

        if (res.data.length === 0) {
            tbody.innerHTML = `<tr class="empty-row"><td colspan="7">No planted plants match. Use <b>Add Planted Plant</b> to register a new plantation record.</td></tr>`;
            document.getElementById("planted-page-info").textContent = "No results";
            document.getElementById("planted-prev-btn").disabled = true;
            document.getElementById("planted-next-btn").disabled = true;
            return;
        }

        tbody.innerHTML = res.data.map(p => {
            const stClass = (p.status || "unknown").toLowerCase();
            // Plant codes are passed to handlers as JSON strings so quotes in codes cannot break the markup
            const codeArg = this.esc(JSON.stringify(p.plant_code || ""));
            return `
                <tr>
                    <td><b>${this.esc(p.plant_code)}</b></td>
                    <td>${p.scientific_name ? `<b><i>${this.esc(p.scientific_name)}</i></b>` : '<span class="muted">Not specified</span>'}</td>
                    <td>${p.common_name ? this.esc(p.common_name) : '<span class="faint">—</span>'}</td>
                    <td style="white-space:nowrap">${this.esc(p.planted_on || "—")}</td>
                    <td>${this.zoneLabel(p.zone_code)}</td>
                    <td><span class="status-badge ${this.esc(stClass)}">${this.esc(p.status)}</span></td>
                    <td class="cell-actions">
                        <button class="btn-action info" onclick="App.openPlantHistoryModal(${Number(p.id)}, ${codeArg})" title="See all health-check visits">📋 History</button>
                        <button class="btn-action success" onclick="App.openMonitoringModal(${Number(p.id)}, ${codeArg})" title="Record a health-check visit">➕ Visit</button>
                        <button class="btn-action" onclick="App.openEditPlantModal(${Number(p.id)})">Edit</button>
                        <button class="btn-action delete" onclick="App.confirmDeletePlant(${Number(p.id)}, ${codeArg})">Delete</button>
                    </td>
                </tr>
            `;
        }).join("");

        document.getElementById("planted-page-info").textContent = `Page ${res.page} of ${res.total_pages} · ${res.total_records} planted plants`;
        document.getElementById("planted-prev-btn").disabled = res.page <= 1;
        document.getElementById("planted-next-btn").disabled = res.page >= res.total_pages;
    },

    changePlantedPage(delta) {
        this.plantedPage += delta;
        this.loadPlantedPlants();
    },

    applyPlantedFilter(field, value) {
        this.plantedFilters[field] = value;
        this.plantedPage = 1;
        this.loadPlantedPlants();
    },

    openAddPlantModal() {
        this.requireAuth(() => this._doOpenAddPlantModal());
    },

    _doOpenAddPlantModal() {
        this.editingPlantId = null;
        document.getElementById("plant-modal-title").textContent = "Add New Planted Plant Record";
        document.getElementById("plant-form").reset();
        document.getElementById("plant-modal").style.display = "flex";
    },

    openEditPlantModal(id) {
        this.requireAuth(() => this._doOpenEditPlantModal(id));
    },

    async _doOpenEditPlantModal(id) {
        try {
            const plant = await ApiService.getPlantedPlantById(id);
            if (!plant) return;

            this.editingPlantId = id;
            document.getElementById("plant-modal-title").textContent = `Edit Plant Record: ${plant.plant_code}`;
            
            document.getElementById("form-plant-code").value = plant.plant_code || "";
            document.getElementById("form-scientific-name").value = plant.scientific_name || "";
            document.getElementById("form-common-name").value = plant.common_name || "";
            document.getElementById("form-planted-on").value = plant.planted_on || "";
            document.getElementById("form-status").value = plant.status || "Alive";
            document.getElementById("form-latitude").value = plant.latitude || "";
            document.getElementById("form-longitude").value = plant.longitude || "";
            document.getElementById("form-zone-code").value = plant.zone_code || "";
            document.getElementById("form-notes").value = plant.notes || "";

            document.getElementById("plant-modal").style.display = "flex";
        } catch (err) {
            this.showErrorBanner(`Failed to fetch plant details: ${err.message}`);
        }
    },

    closePlantModal() {
        document.getElementById("plant-modal").style.display = "none";
    },

    async handlePlantFormSubmit(e) {
        e.preventDefault();

        const photoFileInput = document.getElementById("form-plant-photo-file");
        let uploadedPhotoUrl = null;
        if (photoFileInput && photoFileInput.files && photoFileInput.files.length > 0) {
            try {
                const uploadRes = await ApiService.uploadPhotoObservation(photoFileInput.files[0]);
                if (uploadRes && uploadRes.photo_url) {
                    uploadedPhotoUrl = uploadRes.photo_url;
                }
            } catch (uploadErr) {
                // Photo already stored for another observation: reuse its file
                if (uploadErr.duplicate && uploadErr.duplicate.photo_url) {
                    uploadedPhotoUrl = uploadErr.duplicate.photo_url;
                } else {
                    console.warn("Photo upload warning:", uploadErr);
                }
            }
        }

        const payload = {
            plant_code: document.getElementById("form-plant-code").value.trim(),
            scientific_name: document.getElementById("form-scientific-name").value.trim() || null,
            common_name: document.getElementById("form-common-name").value.trim() || null,
            planted_on: document.getElementById("form-planted-on").value || null,
            status: document.getElementById("form-status").value,
            latitude: parseFloat(document.getElementById("form-latitude").value),
            longitude: parseFloat(document.getElementById("form-longitude").value),
            zone_code: document.getElementById("form-zone-code").value || null,
            notes: document.getElementById("form-notes").value.trim() || null,
            photo_url: uploadedPhotoUrl || document.getElementById("form-photo-url")?.value || null
        };

        try {
            if (this.editingPlantId) {
                await ApiService.updatePlantedPlant(this.editingPlantId, payload);
            } else {
                await ApiService.createPlantedPlant(payload);
            }

            this.closePlantModal();
            this.notify(`🌱 Plant ${payload.plant_code} ${this.editingPlantId ? "updated" : "added"}.`);
            await this.loadPlantedPlants();
            await this.loadOverview();
        } catch (err) {
            this.notify(`Could not save the plant record: ${err.message}`, "error", 7000);
        }
    },

    confirmDeletePlant(id, code) {
        this.requireAuth(() => this._doConfirmDeletePlant(id, code));
    },

    async _doConfirmDeletePlant(id, code) {
        if (confirm(`Are you sure you want to delete Planted Plant '${code}' (ID: ${id})?\n\nThis action cannot be undone.`)) {
            try {
                await ApiService.deletePlantedPlant(id);
                this.notify(`Plant ${code} deleted.`);
                await this.loadPlantedPlants();
                await this.loadOverview();
            } catch (err) {
                this.notify(`Could not delete the plant record: ${err.message}`, "error", 7000);
            }
        }
    },

    openMonitoringModal(plantId, plantCode) {
        this.requireAuth(() => this._doOpenMonitoringModal(plantId, plantCode));
    },

    _doOpenMonitoringModal(plantId, plantCode) {
        this.currentMonitoringPlantId = plantId;
        document.getElementById("plant-monitoring-form").reset();
        document.getElementById("monitoring-plant-subtitle").textContent = `Record a field visit for plant ${plantCode}. The plant's health status will be updated to what you record here.`;
        document.getElementById("mon-date").value = new Date().toISOString().split('T')[0];
        document.getElementById("plant-monitoring-modal").style.display = "flex";
    },

    closeMonitoringModal() {
        document.getElementById("plant-monitoring-modal").style.display = "none";
    },

    async handleMonitoringSubmit(e) {
        e.preventDefault();
        if (!this.currentMonitoringPlantId) return;

        const payload = {
            status: document.getElementById("mon-status").value,
            monitoring_date: document.getElementById("mon-date").value,
            observer: document.getElementById("mon-observer").value.trim() || "RSWF Field Team",
            notes: document.getElementById("mon-notes").value.trim() || null
        };

        try {
            await ApiService.addPlantMonitoringVisit(this.currentMonitoringPlantId, payload);
            this.closeMonitoringModal();
            this.notify(`✅ Visit saved. Plant health is now: ${payload.status}.`);
            await this.loadPlantedPlants();
            await this.loadOverview();
        } catch (err) {
            this.notify(`Could not save the visit: ${err.message}`, "error", 7000);
        }
    },

    async openPlantHistoryModal(plantId, plantCode) {
        document.getElementById("history-modal-title").textContent = `📋 ${plantCode} · Visit History`;
        document.getElementById("history-plant-subtitle").textContent = "All recorded health-check visits for this plant, newest first.";
        const tbody = document.getElementById("history-table-body");
        tbody.innerHTML = `<tr class="empty-row"><td colspan="4">Loading visit history...</td></tr>`;
        document.getElementById("plant-history-modal").style.display = "flex";

        try {
            const history = await ApiService.getPlantMonitoringHistory(plantId);
            if (!history || history.length === 0) {
                tbody.innerHTML = `<tr class="empty-row"><td colspan="4">No visits recorded yet. Use <b>➕ Visit</b> to record the first health check.</td></tr>`;
                return;
            }

            const sorted = [...history].sort((a, b) => String(b.monitoring_date).localeCompare(String(a.monitoring_date)));
            tbody.innerHTML = sorted.map(h => {
                const stClass = (h.status || "unknown").toLowerCase();
                return `
                    <tr>
                        <td style="white-space:nowrap"><b>${this.esc(h.monitoring_date)}</b></td>
                        <td><span class="status-badge ${this.esc(stClass)}">${this.esc(h.status)}</span></td>
                        <td>${this.esc(h.observer || "RSWF Field Team")}</td>
                        <td>${h.notes ? this.esc(h.notes) : '<span class="faint">No notes</span>'}</td>
                    </tr>
                `;
            }).join("");
        } catch (err) {
            tbody.innerHTML = `<tr class="empty-row"><td colspan="4" style="color:#f87171">Could not load history: ${this.esc(err.message)}</td></tr>`;
        }
    },

    closePlantHistoryModal() {
        document.getElementById("plant-history-modal").style.display = "none";
    },

    openAddNgoObsModal() {
        document.getElementById("ngo-obs-form").reset();
        document.getElementById("ngo-obs-modal").style.display = "flex";
    },

    closeNgoObsModal() {
        document.getElementById("ngo-obs-modal").style.display = "none";
    },

    async handleNgoObsSubmit(e) {
        e.preventDefault();

        const photoFileInput = document.getElementById("ngo-photo-file");
        let uploadedPhotoUrl = null;
        if (photoFileInput && photoFileInput.files && photoFileInput.files.length > 0) {
            try {
                const uploadRes = await ApiService.uploadPhotoObservation(photoFileInput.files[0]);
                if (uploadRes && uploadRes.photo_url) {
                    uploadedPhotoUrl = uploadRes.photo_url;
                }
            } catch (uploadErr) {
                // Photo already stored for another observation: reuse its file
                if (uploadErr.duplicate && uploadErr.duplicate.photo_url) {
                    uploadedPhotoUrl = uploadErr.duplicate.photo_url;
                } else {
                    console.warn("Photo upload warning:", uploadErr);
                }
            }
        }

        const payload = {
            scientific_name: document.getElementById("ngo-scientific-name").value.trim() || null,
            common_name: document.getElementById("ngo-common-name").value.trim() || null,
            observed_on: document.getElementById("ngo-observed-on").value || null,
            observer: document.getElementById("ngo-observer").value.trim() || "RSWF NGO Team",
            latitude: parseFloat(document.getElementById("ngo-latitude").value),
            longitude: parseFloat(document.getElementById("ngo-longitude").value),
            notes: document.getElementById("ngo-notes").value.trim() || null,
            photo_url: uploadedPhotoUrl || document.getElementById("ngo-photo-url")?.value || null
        };

        try {
            const created = await ApiService.createNGOObservation(payload);
            this.closeNgoObsModal();
            this.notify(`📝 Field sighting saved${created && created.id ? ` as observation #${created.id}` : ""}.`);
            await this.loadObservations();
            await this.loadOverview();
        } catch (err) {
            this.notify(`Could not save the field sighting: ${err.message}`, "error", 7000);
        }
    },

    // =====================================================================
    // Phase 8 — Dataset Export Download Handlers
    // =====================================================================

    downloadObsExport(format) {
        const source = document.getElementById("export-obs-source").value;
        const zone = document.getElementById("export-obs-zone").value;
        const quality = document.getElementById("export-obs-quality").value;

        const path = format === 'geojson' ? '/observations.geojson' : '/observations.csv';
        const url = ApiService.buildExportUrl(path, {
            source: source,
            zone: zone,
            quality_grade: quality
        });
        ApiService.triggerDownload(url);
    },

    downloadPlantedExport(format) {
        const status = document.getElementById("export-planted-status").value;
        const zone = document.getElementById("export-planted-zone").value;

        const path = format === 'geojson' ? '/planted-plants.geojson' : '/planted-plants.csv';
        const url = ApiService.buildExportUrl(path, {
            status: status,
            zone: zone
        });
        ApiService.triggerDownload(url);
    },

    downloadSpeciesExport() {
        const url = ApiService.buildExportUrl('/species.csv');
        ApiService.triggerDownload(url);
    },

    downloadCompletePackage() {
        const url = ApiService.buildExportUrl('/package.zip');
        ApiService.triggerDownload(url);
    },

    // Phase 14 — Conservation & SDG PDF Report Download Handlers
    downloadConservationReportPdf() {
        ApiService.downloadConservationReportPdf();
    },

    downloadSdgReportPdf() {
        ApiService.downloadSdgReportPdf();
    },

    // =====================================================================
    // Phase 9 — Photo Upload & EXIF GPS Modal Handlers
    // =====================================================================

    openUploadPhotoModal() {
        document.getElementById("upload-photo-form").reset();
        document.getElementById("upload-file-info").style.display = "none";
        document.getElementById("upload-status-indicator").style.display = "none";
        document.getElementById("upload-result-card").style.display = "none";
        document.getElementById("upload-result-preview").style.display = "none";
        document.getElementById("upload-photo-modal").style.display = "flex";
    },

    closeUploadPhotoModal() {
        document.getElementById("upload-photo-modal").style.display = "none";
    },

    handlePhotoSelectionChanged(e) {
        const fileInput = e.target;
        const fileInfo = document.getElementById("upload-file-info");
        if (fileInput.files && fileInput.files.length > 0) {
            const file = fileInput.files[0];
            fileInfo.textContent = `Selected: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
            fileInfo.style.display = "block";
        } else {
            fileInfo.style.display = "none";
        }
    },

    async handlePhotoUploadSubmit(e) {
        e.preventDefault();
        const fileInput = document.getElementById("upload-photo-file");
        if (!fileInput.files || fileInput.files.length === 0) {
            this.notify("Please choose a photo to upload first.", "warning");
            return;
        }

        const file = fileInput.files[0];
        const statusInd = document.getElementById("upload-status-indicator");
        const resultCard = document.getElementById("upload-result-card");
        const resultTitle = document.getElementById("upload-result-title");
        const resultDetails = document.getElementById("upload-result-details");
        const resultPreview = document.getElementById("upload-result-preview");
        const confirmBox = document.getElementById("geotag-confirmation-box");
        const aiContainer = document.getElementById("upload-ai-trigger-container");
        const submitBtn = document.getElementById("btn-upload-submit");

        statusInd.style.display = "block";
        resultCard.style.display = "none";
        if (confirmBox) confirmBox.style.display = "none";
        if (aiContainer) aiContainer.style.display = "none";
        submitBtn.disabled = true;

        try {
            const res = await ApiService.uploadPhotoObservation(file);
            statusInd.style.display = "none";
            submitBtn.disabled = false;

            if (res.photo_url) {
                const fullPhotoUrl = window.APP_CONFIG.getEndpoint(res.photo_url);
                resultPreview.src = fullPhotoUrl;
                resultPreview.style.display = "block";
            }

            // CASE 1: EXIF GPS (Detected from photo metadata)
            if (res.gps_source === "EXIF") {
                resultTitle.innerHTML = "✓ GPS Found";
                resultCard.style.background = "rgba(16, 185, 129, 0.1)";
                resultCard.style.borderColor = "rgba(16, 185, 129, 0.3)";
                resultTitle.style.color = "#10b981";

                resultDetails.innerHTML = `
                    <div style="font-weight:600;color:#10b981;margin-bottom:0.4rem">✓ GPS detected from photo metadata</div>
                    <div><b>Source:</b> GPS data stored in the photo</div>
                    <div><b>Latitude:</b> ${res.latitude.toFixed(6)}</div>
                    <div><b>Longitude:</b> ${res.longitude.toFixed(6)}</div>
                    <div><b>Zone Assignment:</b> <span style="color:#10b981;font-weight:600">${res.zone}</span></div>
                    <div><b>Observation ID:</b> #${res.observation_id}</div>
                    <div style="margin-top:0.4rem;color:#94a3b8">${res.message}</div>
                    ${this.nearbyObservationsNote(res)}
                `;

                if (confirmBox) confirmBox.style.display = "none";
                if (aiContainer) aiContainer.style.display = "flex";
                this.currentUploadedObsId = res.observation_id;

                await this.loadObservations();
                await this.loadOverview();
                if (this.map) await this.loadMapData();
            }
            // CASE 2: VISIBLE IMAGE GEOTAG (Detected from visible overlay - User Confirmation Required)
            else if (res.gps_source === "IMAGE_GEOTAG") {
                resultTitle.innerHTML = "✓ GPS Found";
                resultCard.style.background = "rgba(245, 158, 11, 0.1)";
                resultCard.style.borderColor = "rgba(245, 158, 11, 0.35)";
                resultTitle.style.color = "#fbbf24";

                resultDetails.innerHTML = `
                    <div style="font-weight:600;color:#fbbf24;margin-bottom:0.4rem">✓ GPS detected from image geotag</div>
                    <div><b>Source:</b> Visible Image Geotag</div>
                    <div><b>Latitude:</b> ${res.latitude.toFixed(6)}</div>
                    <div><b>Longitude:</b> ${res.longitude.toFixed(6)}</div>
                    <div><b>Zone Assignment:</b> <span style="color:#fbbf24;font-weight:600">${res.zone}</span></div>
                    <div style="margin-top:0.4rem;color:#cbd5e1">${res.message}</div>
                    ${this.nearbyObservationsNote(res)}
                `;

                this.pendingGeotagData = res;
                if (confirmBox) confirmBox.style.display = "block";
                if (aiContainer) aiContainer.style.display = "none";
            }
            // CASE 3: NO LOCATION
            else {
                resultTitle.innerHTML = "❌ Location not available";
                resultCard.style.background = "rgba(239, 68, 68, 0.1)";
                resultCard.style.borderColor = "rgba(239, 68, 68, 0.3)";
                resultTitle.style.color = "#ef4444";

                resultDetails.innerHTML = `
                    <div style="color:#f87171;font-weight:600;margin-bottom:0.25rem">No GPS metadata or visible geotag was detected in this photo.</div>
                    <div style="color:#94a3b8">GPS information could not be found in the photo metadata or visible image geotag. A valid spatial location within Van Udyan is required for biodiversity mapping.</div>
                `;
                resultPreview.style.display = "none";
                if (confirmBox) confirmBox.style.display = "none";
                if (aiContainer) aiContainer.style.display = "none";
            }

            resultCard.style.display = "block";

        } catch (err) {
            statusInd.style.display = "none";
            submitBtn.disabled = false;

            if (err.duplicate) {
                this.showDuplicateUploadResult(err.duplicate);
                return;
            }

            const isOutside = err.message && err.message.toLowerCase().includes("outside");

            resultTitle.innerHTML = isOutside ? "⚠️ Outside Project Boundary" : "❌ Location not available";
            resultCard.style.background = "rgba(239, 68, 68, 0.1)";
            resultCard.style.borderColor = "rgba(239, 68, 68, 0.3)";
            resultTitle.style.color = "#ef4444";

            resultDetails.innerHTML = `
                <div style="color:#f87171;font-weight:600;margin-bottom:0.25rem">${isOutside ? "Location is outside the Van Udyan project boundary." : "No GPS metadata or visible geotag was detected in this photo."}</div>
                <div style="color:#94a3b8">${err.message}</div>
            `;
            resultPreview.style.display = "none";
            if (confirmBox) confirmBox.style.display = "none";
            if (aiContainer) aiContainer.style.display = "none";
            resultCard.style.display = "block";
        }
    },

    async handleConfirmGeotagLocation() {
        if (!this.pendingGeotagData) {
            this.notify("There is no location waiting to be confirmed.", "warning");
            return;
        }

        const confirmBtn = document.getElementById("btn-confirm-location");
        const confirmBox = document.getElementById("geotag-confirmation-box");
        const aiContainer = document.getElementById("upload-ai-trigger-container");
        const resultTitle = document.getElementById("upload-result-title");
        const resultCard = document.getElementById("upload-result-card");
        const resultDetails = document.getElementById("upload-result-details");

        if (confirmBtn) {
            confirmBtn.disabled = true;
            confirmBtn.textContent = "⏳ Confirming & Saving Observation...";
        }

        try {
            const data = this.pendingGeotagData;
            const res = await ApiService.confirmGeotagLocation(
                data.photo_url,
                data.latitude,
                data.longitude,
                data.captured_at
            );

            this.currentUploadedObsId = res.observation_id;
            this.pendingGeotagData = null;

            resultTitle.innerHTML = "✅ Photo Observation Spatially Verified & Saved!";
            resultCard.style.background = "rgba(16, 185, 129, 0.1)";
            resultCard.style.borderColor = "rgba(16, 185, 129, 0.3)";
            resultTitle.style.color = "#10b981";

            resultDetails.innerHTML = `
                <div style="font-weight:600;color:#10b981;margin-bottom:0.4rem">✓ Location Confirmed by User</div>
                <div><b>Source:</b> Visible Image Geotag (Confirmed)</div>
                <div><b>Observation ID:</b> #${res.observation_id}</div>
                <div><b>Latitude:</b> ${res.latitude.toFixed(6)}</div>
                <div><b>Longitude:</b> ${res.longitude.toFixed(6)}</div>
                <div><b>Zone Assignment:</b> <span style="color:#10b981;font-weight:600">${res.zone}</span></div>
                <div style="margin-top:0.4rem;color:#94a3b8">${res.message}</div>
            `;

            if (confirmBox) confirmBox.style.display = "none";
            if (aiContainer) aiContainer.style.display = "flex";

            await this.loadObservations();
            await this.loadOverview();
            if (this.map) await this.loadMapData();

        } catch (err) {
            if (confirmBtn) {
                confirmBtn.disabled = false;
                confirmBtn.textContent = "Confirm Location";
            }
            if (err.duplicate) {
                this.pendingGeotagData = null;
                this.showDuplicateUploadResult(err.duplicate);
                return;
            }
            this.notify(`Could not confirm the location: ${err.message}`, "error", 7000);
        }
    },

    // Shown when the uploaded photo is already recorded: points the user to the existing
    // observation and makes it the active one, so AI identification continues on that record.
    showDuplicateUploadResult(dup) {
        const resultCard = document.getElementById("upload-result-card");
        const resultTitle = document.getElementById("upload-result-title");
        const resultDetails = document.getElementById("upload-result-details");
        const resultPreview = document.getElementById("upload-result-preview");
        const confirmBox = document.getElementById("geotag-confirmation-box");
        const aiContainer = document.getElementById("upload-ai-trigger-container");

        resultTitle.innerHTML = "📋 This photo is already in the records";
        resultCard.style.background = "rgba(245, 158, 11, 0.08)";
        resultCard.style.borderColor = "rgba(245, 158, 11, 0.35)";
        resultTitle.style.color = "#fbbf24";

        const lat = typeof dup.latitude === "number" ? dup.latitude.toFixed(6) : dup.latitude;
        const lng = typeof dup.longitude === "number" ? dup.longitude.toFixed(6) : dup.longitude;
        const observedOn = dup.observed_on
            ? new Date(dup.observed_on + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
            : "—";
        const species = dup.scientific_name
            ? `<i>${dup.scientific_name}</i>${dup.identification_status === "verified" ? ' <span style="color:#10b981;font-weight:600">✓ Verified</span>' : ' <span style="color:#94a3b8">(unverified)</span>'}`
            : '<span style="color:#94a3b8">Not identified yet</span>';

        const row = (label, value) => `
            <div style="color:#94a3b8">${label}</div>
            <div style="color:#e2e8f0">${value}</div>`;

        resultDetails.innerHTML = `
            <div style="color:#e2e8f0;margin-bottom:0.75rem;line-height:1.5">
                You've uploaded this photo before. It's saved as
                <b style="color:#fbbf24">Observation #${dup.existing_observation_id}</b>,
                so no new record was added.
            </div>
            <div style="display:grid;grid-template-columns:max-content 1fr;gap:0.3rem 1rem;font-size:0.9rem;padding:0.6rem 0.75rem;background:rgba(15,23,42,0.45);border-radius:8px">
                ${row("Species", species)}
                ${row("Zone", `<span style="color:#fbbf24;font-weight:600">${dup.zone}</span>`)}
                ${row("Coordinates", `${lat}, ${lng}`)}
                ${row("Recorded on", observedOn)}
            </div>
            <div style="margin-top:0.75rem;color:#94a3b8;font-size:0.85rem;line-height:1.5">
                To identify it again, use the <b style="color:#cbd5e1">Pl@ntNet AI</b> button below.
                To record a new sighting, upload a different photo.
            </div>
        `;

        if (dup.photo_url) {
            resultPreview.src = window.APP_CONFIG.getEndpoint(dup.photo_url);
            resultPreview.style.display = "block";
        } else {
            resultPreview.style.display = "none";
        }

        this.currentUploadedObsId = dup.existing_observation_id;
        if (confirmBox) confirmBox.style.display = "none";
        if (aiContainer) aiContainer.style.display = "flex";
        resultCard.style.display = "block";
    },

    // Note for results where other observations exist at (almost) the same coordinates.
    nearbyObservationsNote(res) {
        const ids = res.nearby_observation_ids || [];
        if (!ids.length) return "";
        return `<div style="margin-top:0.4rem;color:#fbbf24">⚠️ ${ids.length === 1 ? "Another observation exists" : "Other observations exist"} at the same location (${ids.map(id => "#" + id).join(", ")}). If this is the same plant, it may be a duplicate.</div>`;
    },

    // =====================================================================
    // Phase 10 — Pl@ntNet AI Identification & Verification Handlers
    // =====================================================================

    async triggerCurrentObsAI() {
        if (!this.currentUploadedObsId) {
            this.notify("Upload a photo first, then run the AI identification.", "warning");
            return;
        }

        const organ = document.getElementById("upload-organ-select").value || "auto";
        const aiCard = document.getElementById("ai-prediction-card");
        const aiList = document.getElementById("ai-predictions-list");
        const btnTrigger = document.getElementById("btn-trigger-ai");

        btnTrigger.disabled = true;
        btnTrigger.textContent = "⏳ Analyzing via Pl@ntNet AI...";
        aiCard.style.display = "block";
        aiList.innerHTML = `<div style="color:#a78bfa;font-size:0.85rem">Contacting Pl@ntNet REST API service...</div>`;

        try {
            const res = await ApiService.identifyObservationPlant(this.currentUploadedObsId, organ);
            btnTrigger.disabled = false;
            btnTrigger.textContent = "🤖 Re-run Pl@ntNet AI";

            if (!res.predictions || res.predictions.length === 0) {
                const errMsg = res.result_summary ? res.result_summary.message : "No predictions returned.";
                aiList.innerHTML = `<div style="color:#f87171;padding:0.5rem">⚠️ AI Identification Notice: ${errMsg}</div>`;
                return;
            }

            let html = "";
            res.predictions.forEach(p => {
                let badgeColor = "#ef4444"; // LOW
                let badgeBg = "rgba(239, 68, 68, 0.2)";
                if (p.confidence_level === "HIGH CONFIDENCE") {
                    badgeColor = "#10b981";
                    badgeBg = "rgba(16, 185, 129, 0.2)";
                } else if (p.confidence_level === "MEDIUM CONFIDENCE") {
                    badgeColor = "#f59e0b";
                    badgeBg = "rgba(245, 158, 11, 0.2)";
                }

                html += `
                    <div style="margin-bottom:0.75rem;padding:0.75rem;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:6px">
                        <div style="display:flex;justify-content:space-between;align-items:center">
                            <div>
                                <span style="font-weight:700;color:#c084fc">#${p.rank}</span>
                                <span style="font-weight:600;color:#fff;margin-left:0.4rem">${p.scientific_name}</span>
                                ${p.common_name ? `<span style="color:#94a3b8;font-size:0.8rem"> (${p.common_name})</span>` : ''}
                            </div>
                            <span class="status-badge" style="background:${badgeBg};color:${badgeColor};font-size:0.75rem">${p.confidence_level} (${p.confidence_percentage})</span>
                        </div>
                        
                        <div style="margin-top:0.4rem;background:rgba(255,255,255,0.1);height:6px;border-radius:3px;overflow:hidden">
                            <div style="width:${p.confidence_percentage};background:${badgeColor};height:100%"></div>
                        </div>

                        <div style="display:flex;justify-content:flex-end;gap:0.5rem;margin-top:0.6rem">
                            <button type="button" class="btn-action" style="font-size:0.75rem;padding:0.25rem 0.5rem;background:rgba(16,185,129,0.2);color:#34d399;border:1px solid rgba(16,185,129,0.4)" 
                                onclick="App.confirmAiPredictionRank(${this.currentUploadedObsId}, ${p.rank})">
                                ✅ Confirm #${p.rank} (${p.scientific_name})
                            </button>
                        </div>
                    </div>
                `;
            });

            // Action toolbar for manual correction or flagging review
            html += `
                <div style="display:flex;gap:0.5rem;margin-top:1rem;padding-top:0.75rem;border-top:1px solid rgba(255,255,255,0.1)">
                    <button type="button" class="btn-action" style="flex:1;font-size:0.8rem;background:rgba(59,130,246,0.2);color:#60a5fa;border:1px solid rgba(59,130,246,0.4)" onclick="App.toggleCorrectionForm()">
                        ✏️ Correct Identification
                    </button>
                    <button type="button" class="btn-action" style="flex:1;font-size:0.8rem;background:rgba(245,158,11,0.2);color:#fbbf24;border:1px solid rgba(245,158,11,0.4)" onclick="App.markNeedsReview(${this.currentUploadedObsId})">
                        ❓ Needs Expert Review
                    </button>
                </div>

                <!-- Manual Correction Form (Hidden by default) -->
                <div id="ai-correction-form" style="display:none;margin-top:1rem;padding:0.85rem;background:rgba(15,23,42,0.6);border:1px solid var(--border-color);border-radius:6px">
                    <div style="font-weight:600;color:#e2e8f0;font-size:0.85rem;margin-bottom:0.6rem">✏️ Manual Species Correction Form</div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;margin-bottom:0.5rem">
                        <input type="text" id="verif-correct-sci" placeholder="Scientific Name (Required, e.g. Moringa oleifera)" class="search-input" style="width:100%;font-size:0.8rem">
                        <input type="text" id="verif-correct-com" placeholder="Common Name (e.g. Drumstick Tree)" class="search-input" style="width:100%;font-size:0.8rem">
                    </div>
                    <input type="text" id="verif-correct-notes" placeholder="Correction Reason / Notes (Optional)" class="search-input" style="width:100%;font-size:0.8rem;margin-bottom:0.6rem">
                    <div style="display:flex;justify-content:flex-end;gap:0.5rem">
                        <button type="button" class="btn-action" style="font-size:0.75rem" onclick="App.toggleCorrectionForm()">Cancel</button>
                        <button type="button" class="btn-primary" style="font-size:0.75rem;background:linear-gradient(135deg,#3b82f6,#1d4ed8)" onclick="App.submitManualCorrection(${this.currentUploadedObsId})">Save Correction</button>
                    </div>
                </div>
            `;

            aiList.innerHTML = html;

        } catch (err) {
            btnTrigger.disabled = false;
            btnTrigger.textContent = "🤖 Run Pl@ntNet AI";
            aiList.innerHTML = `<div style="color:#f87171;padding:0.5rem">❌ AI Identification Error: ${err.message}</div>`;
        }
    },

    confirmAiPredictionRank(obsId, rank) {
        this.requireAuth(() => this._doConfirmAiPredictionRank(obsId, rank));
    },

    async _doConfirmAiPredictionRank(obsId, rank) {
        try {
            const res = await ApiService.verifyObservation(obsId, {
                decision: "confirm",
                selected_prediction_rank: rank
            });
            this.notify(`✅ Observation #${obsId} confirmed as ${res.scientific_name}.`);
            await this.loadObservations();
            await this.loadOverview();
            this.closeUploadPhotoModal();
        } catch (err) {
            this.notify(`Could not confirm the species: ${err.message}`, "error", 7000);
        }
    },

    toggleCorrectionForm() {
        const form = document.getElementById("ai-correction-form");
        if (form) {
            form.style.display = form.style.display === "none" ? "block" : "none";
        }
    },

    submitManualCorrection(obsId) {
        this.requireAuth(() => this._doSubmitManualCorrection(obsId));
    },

    async _doSubmitManualCorrection(obsId) {
        const sci = document.getElementById("verif-correct-sci")?.value?.trim();
        const com = document.getElementById("verif-correct-com")?.value?.trim();
        const notes = document.getElementById("verif-correct-notes")?.value?.trim();

        if (!sci) {
            this.notify("Please enter the correct scientific name.", "warning");
            return;
        }

        try {
            const res = await ApiService.verifyObservation(obsId, {
                decision: "correct",
                scientific_name: sci,
                common_name: com || null,
                notes: notes || null
            });
            this.notify(`✏️ Observation #${obsId} corrected to ${res.scientific_name}.`);
            await this.loadObservations();
            await this.loadOverview();
            this.closeUploadPhotoModal();
        } catch (err) {
            this.notify(`Could not save the correction: ${err.message}`, "error", 7000);
        }
    },

    markNeedsReview(obsId) {
        this.requireAuth(() => this._doMarkNeedsReview(obsId));
    },

    async _doMarkNeedsReview(obsId) {
        try {
            await ApiService.verifyObservation(obsId, {
                decision: "needs_review",
                notes: "Flagged by user for expert review"
            });
            this.notify(`❓ Observation #${obsId} flagged for expert review.`);
            await this.loadObservations();
            await this.loadOverview();
            this.closeUploadPhotoModal();
        } catch (err) {
            this.notify(`Could not update the status: ${err.message}`, "error", 7000);
        }
    },

    // =====================================================================
    // Observation details & species review
    // =====================================================================

    async openObservationDetail(obsId) {
        const modal = document.getElementById("obs-detail-modal");
        const body = document.getElementById("obs-detail-body");
        if (!modal || !body) return;
        if (this.leafletMap) this.leafletMap.closePopup();
        document.getElementById("obs-detail-title").textContent = `Observation #${obsId}`;
        body.innerHTML = `<div class="loading-text">Loading observation...</div>`;
        modal.style.display = "flex";
        try {
            const obs = await ApiService.getObservationById(obsId);
            this.currentDetailObs = obs;
            this.renderObservationDetail(obs);
        } catch (err) {
            body.innerHTML = `<div style="color:#f87171">Could not load observation #${Number(obsId)}: ${this.esc(err.message)}</div>`;
        }
    },

    closeObservationDetail() {
        const modal = document.getElementById("obs-detail-modal");
        if (modal) modal.style.display = "none";
        this.currentDetailObs = null;
    },

    renderObservationDetail(o, freshPredictions = null) {
        const body = document.getElementById("obs-detail-body");
        if (!body) return;
        const isNgo = o.source === "NGO / New Upload";
        const id = Number(o.id);

        const photo = o.photo_url && (isNgo || /^https?:\/\//i.test(o.photo_url)) ? this.photoSrc(o.photo_url) : "";
        const photoHtml = photo
            ? `<a href="${this.esc(photo)}" target="_blank" rel="noopener" title="Open full-size photo"><img class="detail-photo" src="${this.esc(photo)}" alt="Observation photo" onerror="App.replaceMissingPhoto(this.parentElement, 'detail-photo-empty', 'Photo file is missing on the server')"></a>`
            : `<div class="detail-photo-empty">${o.observation_url ? "Photo available on iNaturalist" : "No photo attached"}</div>`;

        const gpsSources = {
            EXIF: "GPS data stored in the photo",
            IMAGE_GEOTAG: "Printed location stamp on the photo (confirmed)"
        };
        const lat = typeof o.latitude === "number" ? o.latitude.toFixed(6) : o.latitude;
        const lng = typeof o.longitude === "number" ? o.longitude.toFixed(6) : o.longitude;
        const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lat + "," + lng)}`;

        const meta = [
            ["Status", this.statusBadge(o)],
            ["Source", this.sourceLabel(o.source)],
            ["Observed on", this.esc(o.observed_on || "—")],
            ["Observer", this.esc(o.observer || "—")],
            ["Zone", this.zoneLabel(o.zone)],
            ["Coordinates", `${this.esc(lat)}, ${this.esc(lng)} · <a href="${mapsUrl}" target="_blank" rel="noopener">Google Maps ↗</a>`],
            ["Location from", isNgo ? this.esc(gpsSources[o.gps_source] || o.gps_source || "Entered manually") : "iNaturalist record"],
            ["Confidence", o.identification_confidence ? this.esc({ high: "High", medium: "Medium", none: "Not identified" }[o.identification_confidence] || o.identification_confidence) : ""],
            ["iNaturalist", o.observation_url ? `<a href="${this.esc(o.observation_url)}" target="_blank" rel="noopener">View original record ↗</a>` : ""]
        ].filter(([, v]) => v);

        const suggestions = freshPredictions || o.ai_top_predictions || [];
        const canReview = isNgo;
        const suggestionHtml = suggestions.length ? suggestions.map(p => {
            const name = p.scientific_name || "";
            const nameArg = this.esc(JSON.stringify(name));
            const comArg = this.esc(JSON.stringify(p.common_name || ""));
            return `
                <div class="suggestion-row">
                    <span><b>${Number(p.rank) || ""}.</b> <i>${this.esc(name)}</i>${p.common_name ? ` <span class="muted">(${this.esc(p.common_name)})</span>` : ""}</span>
                    <span style="display:flex;align-items:center;gap:0.5rem">
                        <span class="conf">${this.esc(p.confidence_percentage || "")}</span>
                        ${canReview ? `<button type="button" class="btn-action success" style="margin:0" onclick="App.reviewConfirm(${id}, ${nameArg}, ${comArg})">Use this</button>` : ""}
                    </span>
                </div>`;
        }).join("") : `<div class="loading-text">No AI suggestions saved for this record yet.</div>`;

        const current = o.scientific_name ? this.esc(JSON.stringify(o.scientific_name)) : null;
        const currentCom = this.esc(JSON.stringify(o.common_name || ""));
        const reviewHtml = canReview ? `
            <div class="review-actions">
                ${current && !["verified", "corrected"].includes(o.identification_status)
                    ? `<button type="button" class="btn-primary btn-small" onclick="App.reviewConfirm(${id}, ${current}, ${currentCom})">✅ Confirm ${this.esc(o.scientific_name)}</button>` : ""}
                <button type="button" class="btn-primary btn-blue btn-small" onclick="App.toggleReviewCorrection()">✏️ Enter correct species</button>
                <button type="button" class="btn-action" onclick="App.reviewNeedsExpert(${id})">❓ Needs expert review</button>
                <button type="button" class="btn-action" id="btn-detail-rerun-ai" onclick="App.rerunDetailAI(${id})">🤖 ${suggestions.length ? "Re-run" : "Run"} Pl@ntNet AI</button>
            </div>
            <div id="review-correction-form" class="review-form" style="display:none">
                <div class="form-grid-2">
                    <div class="form-group"><label for="review-sci">Scientific name <span class="req">*</span></label><input type="text" id="review-sci" placeholder="e.g. Moringa oleifera" value="${this.esc(o.scientific_name || "")}"></div>
                    <div class="form-group"><label for="review-com">Common name</label><input type="text" id="review-com" placeholder="e.g. Drumstick tree" value="${this.esc(o.common_name || "")}"></div>
                </div>
                <div class="form-group"><label for="review-notes">Reason / notes</label><input type="text" id="review-notes" placeholder="e.g. Checked leaves and flowers in the field"></div>
                <div style="display:flex;justify-content:flex-end;gap:0.5rem">
                    <button type="button" class="btn-action" onclick="App.toggleReviewCorrection()">Cancel</button>
                    <button type="button" class="btn-primary btn-blue btn-small" onclick="App.reviewCorrect(${id})">Save species</button>
                </div>
            </div>
            <div class="form-hint">Confirming or correcting a species needs the RSWF admin password.</div>`
            : `<div class="note-card" style="margin-top:1rem">iNaturalist records are public reference data and are kept exactly as published, so they cannot be edited here.</div>`;

        body.innerHTML = `
            <div class="detail-layout">
                <div>${photoHtml}</div>
                <div>
                    <div class="detail-name">${o.scientific_name ? `<i>${this.esc(o.scientific_name)}</i>` : "Not identified yet"}</div>
                    ${o.common_name ? `<div class="detail-common">${this.esc(o.common_name)}</div>` : ""}
                    <dl class="detail-meta">${meta.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
                    ${isNgo ? `<div class="detail-section-title">${freshPredictions ? "New AI suggestions" : "AI suggestions (Pl@ntNet)"}</div>${suggestionHtml}` : ""}
                    ${o.verification_notes || o.notes ? `<div class="detail-section-title">Notes</div><div class="detail-notes">${this.esc(o.verification_notes || o.notes)}</div>` : ""}
                    ${reviewHtml}
                </div>
            </div>`;
    },

    toggleReviewCorrection() {
        const form = document.getElementById("review-correction-form");
        if (form) form.style.display = form.style.display === "none" ? "block" : "none";
    },

    async afterReview(obsId, message) {
        this.notify(message);
        const refreshed = await ApiService.getObservationById(obsId).catch(() => null);
        if (refreshed && document.getElementById("obs-detail-modal").style.display !== "none") {
            this.currentDetailObs = refreshed;
            this.renderObservationDetail(refreshed);
        }
        if (this.currentTab === "observations") await this.loadObservations();
        this.loadReviewCount();
    },

    reviewConfirm(obsId, scientificName, commonName) {
        this.requireAuth(async () => {
            try {
                const res = await ApiService.verifyObservation(obsId, {
                    decision: "confirm",
                    scientific_name: scientificName,
                    common_name: commonName || null
                });
                await this.afterReview(obsId, `✅ Observation #${obsId} confirmed as ${res.scientific_name || scientificName}.`);
            } catch (err) {
                this.notify(`Could not confirm the species: ${err.message}`, "error", 7000);
            }
        });
    },

    reviewCorrect(obsId) {
        const sci = document.getElementById("review-sci")?.value?.trim();
        const com = document.getElementById("review-com")?.value?.trim();
        const notes = document.getElementById("review-notes")?.value?.trim();
        if (!sci) {
            this.notify("Please enter the correct scientific name.", "warning");
            return;
        }
        this.requireAuth(async () => {
            try {
                const res = await ApiService.verifyObservation(obsId, {
                    decision: "correct",
                    scientific_name: sci,
                    common_name: com || null,
                    notes: notes || null
                });
                await this.afterReview(obsId, `✏️ Observation #${obsId} saved as ${res.scientific_name || sci}.`);
            } catch (err) {
                this.notify(`Could not save the species: ${err.message}`, "error", 7000);
            }
        });
    },

    reviewNeedsExpert(obsId) {
        this.requireAuth(async () => {
            try {
                await ApiService.verifyObservation(obsId, { decision: "needs_review", notes: "Flagged for expert review" });
                await this.afterReview(obsId, `❓ Observation #${obsId} flagged for expert review.`);
            } catch (err) {
                this.notify(`Could not update the status: ${err.message}`, "error", 7000);
            }
        });
    },

    async rerunDetailAI(obsId) {
        const btn = document.getElementById("btn-detail-rerun-ai");
        if (btn) { btn.disabled = true; btn.textContent = "⏳ Asking Pl@ntNet..."; }
        try {
            const res = await ApiService.identifyObservationPlant(obsId, "auto");
            if (!res.predictions || res.predictions.length === 0) {
                const msg = res.result_summary ? res.result_summary.message : "No suggestions returned.";
                this.notify(`Pl@ntNet: ${msg}`, "warning", 8000);
                if (btn) { btn.disabled = false; btn.textContent = "🤖 Re-run Pl@ntNet AI"; }
                return;
            }
            if (this.currentDetailObs && Number(this.currentDetailObs.id) === Number(obsId)) {
                this.renderObservationDetail(this.currentDetailObs, res.predictions);
            }
        } catch (err) {
            this.notify(`AI identification failed: ${err.message}`, "error", 7000);
            if (btn) { btn.disabled = false; btn.textContent = "🤖 Re-run Pl@ntNet AI"; }
        }
    },

    // Helpers
    showErrorBanner(msg) {
        const banner = document.getElementById("global-error-banner");
        if (banner) {
            banner.style.display = "flex";
            document.getElementById("global-error-message").textContent = msg;
        }
    },

    clearErrorBanner() {
        const banner = document.getElementById("global-error-banner");
        if (banner) banner.style.display = "none";
    }
};

window.App = App;
