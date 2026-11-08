import React, { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import Sidebar from './Styles/Components/Sidebar/Sidebar';
import { PromptsModalManager } from './Styles/Components/PromptContent';
import { App } from './Core/App';
import { globalState } from './Core/State';
import { Icon } from './UI/Icons';

const AppInitializer: React.FC = () => {
    const initialized = useRef(false);
    useEffect(() => {
        if (!initialized.current) {
            App.init();
            initialized.current = true;
        }
    }, []);
    return null;
};

const MainContent: React.FC = () => {
    const showTabs = Boolean(globalState.activeDeepthinkPipeline);

    return (
        <main id="main-content" className="flow-canvas-wrapper" aria-labelledby="main-content-heading">
            <h2 id="main-content-heading" className="sr-only">Generation Pipelines Output</h2>
            <div className="main-header-content">
                <button id="sidebar-expand-button" className="sidebar-expand-button" aria-label="Expand Sidebar" title="Expand Sidebar" style={{ display: 'none' }}>
                    <Icon name="dock_to_left" />
                </button>
                <div id="tabs-nav-container" className="tabs-container" role="tablist" aria-label="Results" style={{ display: showTabs ? '' : 'none' }} />
            </div>
            <div id="pipelines-content-container" className="results-content-area custom-scrollbar" />
        </main>
    );
};

document.addEventListener('DOMContentLoaded', () => {
    const appContainer = document.getElementById('app-container');
    if (appContainer) {
        createRoot(appContainer).render(
            <React.StrictMode>
                <AppInitializer />
                <Sidebar />
                <MainContent />
            </React.StrictMode>
        );
    }

    const modalContainer = document.createElement('div');
    document.body.appendChild(modalContainer);
    createRoot(modalContainer).render(
        <React.StrictMode>
            <PromptsModalManager />
        </React.StrictMode>
    );
});
