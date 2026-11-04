import { createBrowserRouter, Outlet, useLocation, Link, useRouteError } from "react-router";
import { lazy, Suspense } from "react";
import { API_BASE } from "../api/client";

const TripSetupDashboard = lazy(() => import("./pages/TripSetupDashboard"));
const DriveAndSummary    = lazy(() => import("./pages/DriveAndSummary"));
const PipelineMonitor    = lazy(() => import("./pages/PipelineMonitor"));
const ServerConsole      = lazy(() => import("./pages/ServerConsole"));

function Spinner() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#f9fafb' }}>
      <div style={{ width: 32, height: 32, border: '3px solid #001E50', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

/** Nav bar — shown on / and /pipeline, hidden on /drive (full-screen nav) */
function Layout() {
  const { pathname } = useLocation();
  const showNav = pathname !== '/drive';
  sessionStorage.removeItem('vw_chunk_reload');   // a page rendered fine — re-arm the one-time auto reload
  return (
    <>
      {showNav && (
        <nav style={{
          display: 'flex', alignItems: 'center', gap: 0,
          background: '#001E50', height: 44, padding: '0 20px',
          borderBottom: '1px solid rgba(255,255,255,.1)',
          position: 'sticky', top: 0, zIndex: 100,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginRight: 32 }}>
            <div style={{
              width: 26, height: 26, background: 'rgba(255,255,255,.15)',
              borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 10, fontWeight: 700, color: '#fff',
            }}>VW</div>
            <span style={{ color: '#fff', fontWeight: 700, fontSize: 13 }}>Hazard Detection</span>
          </div>

          {[
            { to: '/',         label: '🚗 Trip & Navigation' },
            { to: '/pipeline', label: '🔬 Live Detection (on car)' },
            { to: '/server',   label: '🌐 Global Server' },
          ].map(({ to, label }) => (
            <Link key={to} to={to} style={{
              color: pathname === to ? '#fff' : 'rgba(255,255,255,.55)',
              fontWeight: pathname === to ? 600 : 400,
              fontSize: 13,
              padding: '0 14px',
              height: 44,
              display: 'flex',
              alignItems: 'center',
              borderBottom: pathname === to ? '2px solid #fff' : '2px solid transparent',
              textDecoration: 'none',
              transition: 'color .15s',
            }}>{label}</Link>
          ))}
          <span style={{ marginLeft: 'auto', color: 'rgba(255,255,255,.6)', fontSize: 12 }}>
            car agent: {API_BASE.replace(/^https?:\/\//, '')}
          </span>
        </nav>
      )}
      <Suspense fallback={<Spinner />}>
        <Outlet />
      </Suspense>
    </>
  );
}

/** After Vite re-bundles dependencies, lazy pages can fail to load once — reload instead of crashing. */
function RouteError() {
  const err = useRouteError() as Error | undefined;
  const msg = err?.message ?? String(err);
  if (/dynamically imported module|Importing a module script failed/i.test(msg)
      && !sessionStorage.getItem('vw_chunk_reload')) {
    sessionStorage.setItem('vw_chunk_reload', '1');
    window.location.reload();
    return <Spinner />;
  }
  sessionStorage.removeItem('vw_chunk_reload');
  return (
    <div style={{ padding: 32, fontFamily: 'system-ui' }}>
      <h2>Something went wrong</h2>
      <pre style={{ whiteSpace: 'pre-wrap', color: '#b91c1c' }}>{msg}</pre>
      <button onClick={() => window.location.reload()}>Reload</button>
    </div>
  );
}

export const router = createBrowserRouter([
  {
    element: <Layout />,
    errorElement: <RouteError />,
    children: [
      { path: '/',         element: <TripSetupDashboard /> },
      { path: '/drive',    element: <DriveAndSummary /> },
      { path: '/pipeline', element: <PipelineMonitor /> },
      { path: '/server',   element: <ServerConsole /> },
    ],
  },
]);
