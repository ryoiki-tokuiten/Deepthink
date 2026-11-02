import { globalState } from '../Core/State';
import { setIconSlot } from './Icons';

let sidebarIsCollapsed = false;

export function disableSidebarCollapseButton(reason = 'Sidebar collapse disabled in this view'): void {
    const collapseButton = document.getElementById('sidebar-collapse-button') as HTMLButtonElement | null;
    if (!collapseButton) return;
    collapseButton.disabled = true;
    collapseButton.style.opacity = '0.35';
    collapseButton.style.cursor = 'not-allowed';
    collapseButton.title = reason;
    collapseButton.setAttribute('aria-label', reason);
}

function getSidebarCollapseDisabledReason(): string | null {
    const header = document.querySelector<HTMLElement>('.main-header-content');
    if (header) {
        const style = window.getComputedStyle(header);
        if (style.display !== 'none' && style.visibility !== 'hidden') return null;
    }
    if (globalState.currentMode === 'contextual' && document.querySelector('.contextual-text-panel')) return null;
    if (globalState.currentMode === 'adaptive-deepthink' && document.querySelector('.adaptive-deepthink-embedded-panel')) return null;

    if (globalState.currentMode === 'deepthink') return 'Sidebar collapse disabled in config view';
    if (globalState.currentMode === 'contextual') return 'Sidebar collapse disabled until a Contextual run is visible';
    if (globalState.currentMode === 'adaptive-deepthink') return 'Sidebar collapse disabled until an Adaptive Deepthink run is visible';
    return 'Sidebar collapse is disabled in this view';
}

function expandSidebar(): void {
    const sidebar = document.getElementById('controls-sidebar');
    const expandButton = document.getElementById('sidebar-expand-button');
    if (sidebar) {
        sidebar.classList.remove('collapsed');
        sidebarIsCollapsed = false;
    }
    if (expandButton) expandButton.style.display = 'none';
}

function syncSidebarCollapseAvailability(): void {
    const reason = getSidebarCollapseDisabledReason();
    const expandButton = document.getElementById('sidebar-expand-button');
    if (!reason) {
        const collapseButton = document.getElementById('sidebar-collapse-button') as HTMLButtonElement | null;
        if (collapseButton) {
            collapseButton.disabled = false;
            collapseButton.style.opacity = '';
            collapseButton.style.cursor = '';
            collapseButton.title = 'Collapse Sidebar';
            collapseButton.setAttribute('aria-label', 'Collapse Sidebar');
        }
        if (expandButton) expandButton.style.display = sidebarIsCollapsed ? 'flex' : 'none';
        return;
    }
    if (document.getElementById('controls-sidebar')?.classList.contains('collapsed')) {
        expandSidebar();
    }
    disableSidebarCollapseButton(reason);
    if (expandButton) expandButton.style.display = sidebarIsCollapsed ? 'flex' : 'none';
}

export class LayoutController {
    public static initialize() {
        const expandButton = document.getElementById('sidebar-expand-button');
        const collapseButton = document.getElementById('sidebar-collapse-button');
        const sidebar = document.getElementById('controls-sidebar');
        const mainContent = document.getElementById('main-content');

        expandButton?.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            expandSidebar();
        });

        if (collapseButton && sidebar) {
            const newCollapseButton = collapseButton.cloneNode(true) as HTMLElement;
            collapseButton.replaceWith(newCollapseButton);
            newCollapseButton.addEventListener('click', e => {
                e.preventDefault();
                e.stopPropagation();
                if (!getSidebarCollapseDisabledReason()) {
                    sidebar.style.transition = 'all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)';
                    sidebar.classList.add('collapsed');
                    sidebarIsCollapsed = true;
                }
                requestAnimationFrame(() => {
                    const expandBtn = document.getElementById('sidebar-expand-button');
                    if (expandBtn) expandBtn.style.display = 'flex';
                    if (mainContent) {
                        mainContent.style.transform = 'translateZ(0)';
                        setTimeout(() => { mainContent.style.transform = ''; }, 300);
                    }
                });
            });
        }

        const setThemeIcon = (isLight: boolean) => {
            const icon = document.getElementById('theme-toggle-button')?.querySelector('.icon-slot') as HTMLElement | null;
            if (icon) setIconSlot(icon, isLight ? 'dark_mode' : 'light_mode');
        };

        document.addEventListener('click', e => {
            const target = (e.target as HTMLElement).closest('#theme-toggle-button');
            if (target) {
                e.preventDefault();
                e.stopPropagation();
                const isLight = document.body.classList.toggle('light-mode');
                setThemeIcon(isLight);
                localStorage.setItem('theme', isLight ? 'light' : 'dark');
            }
        }, true);

        document.addEventListener('fullscreenchange', () => {
            const fullscreenElement = document.fullscreenElement;
            document.querySelectorAll<HTMLButtonElement>('.fullscreen-toggle-button').forEach(btn => {
                const iconFullscreen = btn.querySelector<HTMLElement>('.icon-fullscreen');
                const iconExitFullscreen = btn.querySelector<HTMLElement>('.icon-exit-fullscreen');
                const associatedPreview = document.getElementById(btn.id.replace('fullscreen-btn-', 'preview-container-'));
                const active = !!fullscreenElement && fullscreenElement === associatedPreview;
                if (iconFullscreen) iconFullscreen.style.display = active ? 'none' : 'inline-block';
                if (iconExitFullscreen) iconExitFullscreen.style.display = active ? 'inline-block' : 'none';
                const label = active ? 'Exit Fullscreen Preview' : 'Toggle Fullscreen Preview';
                btn.title = label;
                btn.setAttribute('aria-label', label);
            });
        });

        if (localStorage.getItem('theme') === 'light') {
            document.body.classList.add('light-mode');
            setThemeIcon(true);
        }

        const tabsContainer = document.getElementById('tabs-nav-container');
        if (tabsContainer) {
            new MutationObserver(syncSidebarCollapseAvailability).observe(tabsContainer, { childList: true, subtree: true });
        }
        if (mainContent) {
            new MutationObserver(syncSidebarCollapseAvailability).observe(mainContent, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['style', 'class'],
            });
        }

        (window as any).reinitializeSidebarControls = syncSidebarCollapseAvailability;
        window.addEventListener('appModeChanged', syncSidebarCollapseAvailability);
        syncSidebarCollapseAvailability();
    }
}
