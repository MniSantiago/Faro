import { createRoot } from 'react-dom/client';
import { App } from './App';
import { registerServiceWorker, reloadOnNewVersion } from './pwa';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);

registerServiceWorker();
reloadOnNewVersion();
