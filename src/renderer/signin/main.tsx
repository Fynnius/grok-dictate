import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SignInView } from './SignInView.js';
import '../settings/panels.css';
import './signin.css';

const container = document.getElementById('root');
if (container !== null) {
  createRoot(container).render(
    <StrictMode>
      <SignInView />
    </StrictMode>,
  );
}
