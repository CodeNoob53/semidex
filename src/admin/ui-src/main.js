import './app.css';
import { startAdminApp } from './app.js';

// The static layout (topbar/sidebar/main containers) lives directly in
// index.html — this file only wires up styles and starts the app. It does
// not inject any HTML into the page.
startAdminApp();
