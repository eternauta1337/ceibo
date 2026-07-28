import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Build estático que sirve el gateway (@ceibo/gateway) en :8820 detrás del nginx
// de la box. base "/" → los assets se referencian absolutos (/assets/...), así andan
// igual servidos en "/" que en "/<handle>" (SPA fallback en el gateway). En dev, el
// proxy manda /api (incluye el stream SSE /api/stream) a un gateway.
//
// Por default apunta al gateway LOCAL (:8820). Para iterar la UI contra el BOX real sin
// levantar backend local, seteá VITE_API_TARGET=https://ceibo.example.com (opt-in explícito): además
// del target remoto, (1) spoofeamos el Origin → pasa el check CSRF del box; (2) reescribimos
// la cookie de sesión a host-only y le sacamos `Secure` → el browser la guarda en http://localhost.
// Login: pedí el magic link con `/web` en Telegram y abrí ese `?t=…` en localhost:5173.
const API_TARGET = process.env.VITE_API_TARGET ?? "http://127.0.0.1:8820";
const REMOTE = API_TARGET.startsWith("https://");

// La versión visible en la web viene ahora del runtime (GET /api/version → SHA del deploy),
// no del build. Ya no se inyecta ninguna variable en build time.

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: API_TARGET,
        // changeOrigin reescribe el Host al target. Para el BOX remoto hace falta (+ spoof de
        // Origin abajo) para pasar su vhost/CSRF. Para el target LOCAL NO: el web-server hace un
        // check same-origin (Origin.host === Host); si reescribimos Host a 127.0.0.1:8820 pero el
        // Origin sigue siendo localhost:5173, da 403 bad-origin (rompía el login en dev). Con
        // false el Host queda localhost:5173 y matchea el Origin del browser.
        changeOrigin: REMOTE,
        ...(REMOTE && {
          cookieDomainRewrite: "",
          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq) => proxyReq.setHeader("origin", API_TARGET));
            proxy.on("proxyRes", (proxyRes) => {
              const sc = proxyRes.headers["set-cookie"];
              if (sc) proxyRes.headers["set-cookie"] = sc.map((c) => c.replace(/;\s*Secure/gi, ""));
            });
          },
        }),
      },
    },
  },
});
