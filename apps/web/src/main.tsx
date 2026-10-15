import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);

if (location.protocol.startsWith('http')) {
  import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true }));
}
