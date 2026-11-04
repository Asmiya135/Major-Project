/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_EDGE_URL: string;     // this car's edge agent (default http://localhost:8001)
  readonly VITE_SERVER_URL: string;   // the global server (default http://localhost:8000)
  readonly VITE_OLA_MAPS_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
