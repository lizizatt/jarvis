import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Dashboard } from './pages/Dashboard';

const RepositoryDetail = lazy(() => import('./pages/RepositoryDetail').then((module) => ({ default: module.RepositoryDetail })));

export function App() {
  return <BrowserRouter><Suspense fallback={<main className="page"><div className="empty">Loading workspace…</div></main>}><Routes><Route path="/" element={<Dashboard />} /><Route path="/repositories/:id" element={<RepositoryDetail />} /><Route path="*" element={<Navigate to="/" replace />} /></Routes></Suspense></BrowserRouter>;
}
