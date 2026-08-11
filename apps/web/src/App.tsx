import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Dashboard } from './pages/Dashboard';

const RepositoryDetail = lazy(() => import('./pages/RepositoryDetail').then((module) => ({ default: module.RepositoryDetail })));
const Settings = lazy(() => import('./pages/Settings').then((module) => ({ default: module.Settings })));
const TaskHistory = lazy(() => import('./pages/TaskHistory').then((module) => ({ default: module.TaskHistory })));
const SystemDetail = lazy(() => import('./pages/SystemDetail').then((module) => ({ default: module.SystemDetail })));

export function App() {
  return <BrowserRouter><Suspense fallback={<main className="page"><div className="empty">Loading workspace…</div></main>}><Routes><Route path="/" element={<Dashboard />} /><Route path="/repositories/:id" element={<RepositoryDetail />} /><Route path="/repositories/:id/history" element={<TaskHistory />} /><Route path="/settings" element={<Settings />} /><Route path="/system" element={<SystemDetail />} /><Route path="*" element={<Navigate to="/" replace />} /></Routes></Suspense></BrowserRouter>;
}
