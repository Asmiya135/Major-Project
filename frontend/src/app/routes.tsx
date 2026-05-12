import { createBrowserRouter, Outlet, useLocation, Link } from "react-router";
import { lazy, Suspense } from "react";

const TripSetupDashboard = lazy(() => import("./pages/TripSetupDashboard"));
const DriveAndSummary    = lazy(() => import("./pages/DriveAndSummary"));
const PipelineMonitor    = lazy(() => import("./pages/PipelineMonitor"));

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
            { to: '/',         label: '🚗 Driver View' },
            { to: '/pipeline', label: '🔬 Pipeline Monitor' },
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
        </nav>
      )}
      <Suspense fallback={<Spinner />}>
        <Outlet />
      </Suspense>
    </>
  );
}

export const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/',         element: <TripSetupDashboard /> },
      { path: '/drive',    element: <DriveAndSummary /> },
      { path: '/pipeline', element: <PipelineMonitor /> },
    ],
  },
]);
