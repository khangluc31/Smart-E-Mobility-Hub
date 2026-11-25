// Root route table (ARCHITECTURE §13, CONTRACTS §16).

import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { RequireAuth } from '@/components/layout/RequireAuth';
import { RequireRole } from '@/components/layout/RequireRole';
import { StudentLayout } from '@/components/layout/StudentLayout';
import { OperatorLayout } from '@/components/layout/OperatorLayout';
import { TodoPage } from '@/components/common/TodoPage';
import { NotFound } from '@/components/common/NotFound';
import { Login } from '@/pages/Login';
import { Register } from '@/pages/Register';
import { ChangePassword } from '@/pages/ChangePassword';
import { HubList } from '@/pages/student/HubList';
import { HubDetail } from '@/pages/student/HubDetail';
import { VehicleSearch } from '@/pages/student/VehicleSearch';
import { MyReservations } from '@/pages/student/MyReservations';
import { ParkingBooking } from '@/pages/student/ParkingBooking';
import { Charging } from '@/pages/student/Charging';
import { MyVehicles } from '@/pages/student/MyVehicles';
import { Dashboard } from '@/pages/operator/Dashboard';
import { Alerts } from '@/pages/operator/Alerts';
import { Incidents } from '@/pages/operator/Incidents';
import { Skeleton } from '@/components/ui/skeleton';

function HomeRedirect() {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4" aria-busy="true">
        <Skeleton className="h-24 w-full max-w-md" />
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to={user.role === 'OPERATOR' ? '/ops' : '/app/hubs'} replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<HomeRedirect />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />

      {/* Student routes (+ shared /app/change-password outside StudentLayout) */}
      <Route path="/app" element={<RequireAuth />}>
        <Route path="change-password" element={<ChangePassword />} />
        <Route element={<StudentLayout />}>
          <Route index element={<Navigate to="/app/hubs" replace />} />
          <Route path="hubs" element={<HubList />} />
          <Route path="hubs/:hubId" element={<HubDetail />} />
          <Route path="vehicles" element={<VehicleSearch />} />
          <Route path="reservations" element={<MyReservations />} />
          <Route path="parking" element={<ParkingBooking />} />
          <Route path="charging" element={<Charging />} />
          <Route path="my-vehicles" element={<MyVehicles />} />
        </Route>
      </Route>

      {/* Operator routes (FR-61) */}
      <Route path="/ops" element={<RequireAuth />}>
        <Route element={<RequireRole role="OPERATOR" />}>
          <Route element={<OperatorLayout />}>
            <Route index element={<Dashboard />} />
            <Route path="alerts" element={<Alerts />} />
            <Route path="incidents" element={<Incidents />} />
            <Route
              path="charging"
              element={
                <TodoPage
                  title="Charging Queue & Schedule"
                  area="priority charging & overrides"
                  owner="M6"
                />
              }
            />
            <Route
              path="redistribution"
              element={
                <TodoPage
                  title="Vehicle Redistribution"
                  area="imbalance detection & redistribution tasks"
                  owner="M2"
                />
              }
            />
            <Route
              path="simulation"
              element={
                <TodoPage
                  title="What-if Simulation"
                  area="snapshot simulation & recommendations"
                  owner="M2"
                />
              }
            />
            <Route
              path="demo"
              element={
                <TodoPage
                  title="Telemetry Demo Controls"
                  area="simulated sensor feed & fault injection"
                  owner="M1"
                />
              }
            />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

export default App;
