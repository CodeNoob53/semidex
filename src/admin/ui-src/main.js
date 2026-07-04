import './app.css';
import shell from './partials/app-shell.html?raw';
import { startAdminApp } from './app.js';

document.body.innerHTML = shell;
startAdminApp();
