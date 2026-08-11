import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import './frostSettings';
import './styles.css';

registerSW({
	immediate: true,
	onRegisteredSW: (_url, registration) => {
		if (registration) window.setInterval(() => void registration.update(), 60_000);
	},
});
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
