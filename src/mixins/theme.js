import { DEFAULT_ACCENT, accentHex, iconDataUrl } from "../util.ts";

export default {
    data() {
        return {
            system: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
            userTheme: localStorage.theme,
            userHeartbeatBar: localStorage.heartbeatBarTheme,
            styleElapsedTime: localStorage.styleElapsedTime,
            statusPageTheme: "light",
            // Per account rather than per browser: two people sharing an
            // instance should see their own colour wherever they sign in.
            accentColor: DEFAULT_ACCENT,
            // The logo and the favicon, redrawn in the accent. Empty until the
            // source has been read, which is why the markup falls back to the
            // file on disk.
            iconUrl: "",
            iconSource: "",
            forceStatusPageTheme: false,
            path: "",
        };
    },

    mounted() {
        // Default Light
        if (!this.userTheme) {
            this.userTheme = "auto";
        }

        // Default Heartbeat Bar
        if (!this.userHeartbeatBar) {
            this.userHeartbeatBar = "normal";
        }

        // Default Elapsed Time Style
        if (!this.styleElapsedTime) {
            this.styleElapsedTime = "no-line";
        }

        document.body.classList.add(this.theme);
        this.applyAccent();
        this.updateThemeColorMeta();
        this.loadIcon();
    },

    computed: {
        theme() {
            // As entry can be status page now, set forceStatusPageTheme to true to use status page theme
            if (this.forceStatusPageTheme) {
                if (this.statusPageTheme === "auto") {
                    return this.system;
                }
                return this.statusPageTheme;
            }

            // Entry no need dark
            if (this.path === "") {
                return "light";
            }

            if (this.path.startsWith("/status-page") || this.path.startsWith("/status")) {
                if (this.statusPageTheme === "auto") {
                    return this.system;
                }
                return this.statusPageTheme;
            } else {
                if (this.userTheme === "auto") {
                    return this.system;
                }
                return this.userTheme;
            }
        },

        isDark() {
            return this.theme === "dark";
        },
    },

    watch: {
        "$route.fullPath"(path) {
            this.path = path;
        },

        userTheme(to, from) {
            localStorage.theme = to;
        },

        styleElapsedTime(to, from) {
            localStorage.styleElapsedTime = to;
        },

        theme(to, from) {
            document.body.classList.remove(from);
            document.body.classList.add(this.theme);
            this.updateThemeColorMeta();
        },

        userHeartbeatBar(to, from) {
            localStorage.heartbeatBarTheme = to;
        },

        accentColor() {
            this.applyAccent();
            this.updateThemeColorMeta();
        },

        heartbeatBarTheme(to, from) {
            document.body.classList.remove(from);
            document.body.classList.add(this.heartbeatBarTheme);
        },
    },

    methods: {
        /**
         * Paint the interface in this account's accent.
         *
         * One custom property on the root element: every rule that shows the
         * accent reads it, so the whole page follows without a reload.
         * @returns {void}
         */
        applyAccent() {
            document.documentElement.style.setProperty("--accent", accentHex(this.accentColor));
            this.applyIcon();
        },

        /**
         * Read the icon once, so it can be redrawn without fetching again.
         * @returns {Promise<void>} Promise
         */
        async loadIcon() {
            try {
                const res = await fetch("/icon.svg");
                this.iconSource = await res.text();
                this.applyIcon();
            } catch (e) {
                // The shipped file stays in place; only the recolouring is lost.
            }
        },

        /**
         * Redraw the logo and the favicon in this account's accent.
         * @returns {void}
         */
        applyIcon() {
            if (!this.iconSource) {
                return;
            }
            this.iconUrl = iconDataUrl(this.iconSource, accentHex(this.accentColor));

            const link = document.querySelector("link[rel='icon']");
            if (link) {
                link.setAttribute("href", this.iconUrl);
            }
        },

        /**
         * Update the theme color meta tag
         * @returns {void}
         */
        updateThemeColorMeta() {
            if (this.theme === "dark") {
                document.querySelector("#theme-color").setAttribute("content", "#161B22");
            } else {
                document.querySelector("#theme-color").setAttribute("content", accentHex(this.accentColor));
            }
        },
    },
};
