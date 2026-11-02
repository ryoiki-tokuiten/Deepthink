import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import {
    startContextualProcess,
    stopContextualProcess,
    getContextualState,
    setContextualStateForImport,
    setContextualStateUpdateCallback,
    type ContextualState,
    type ContextualMessage,
} from './ContextualCore';
import RenderMathMarkdown from '../Styles/Components/RenderMathMarkdown';
import { Icon, setIconSlot } from '../UI/Icons';
import { AgentActivityPanel as SharedAgentActivityPanel, SandboxAgentActivity } from '../Styles/Components/AgentActivity/AgentActivityPanel';

export { startContextualProcess, stopContextualProcess, getContextualState, setContextualStateForImport };

interface ModalMessage {
    id: string;
    role: string;
    content: string;
    iterationNumber: number;
    executionTraceText?: string;
}

let modalRoot: Root | null = null;
let modalContainer: HTMLElement | null = null;

function destroyModalRoot() {
    if (modalRoot) {
        modalRoot.unmount();
        modalRoot = null;
    }
    modalContainer?.remove();
    modalContainer = null;
}

const EmbeddedModalViewer: React.FC<{
    title: string;
    content: string;
    currentMessage?: ModalMessage;
    allMessages?: ModalMessage[];
    onClose: () => void;
}> = ({ title, content, currentMessage, allMessages, onClose }) => {
    const modalRef = useRef<HTMLDivElement>(null);
    const contentWrapperRef = useRef<HTMLDivElement>(null);
    const transitionTimeoutRef = useRef<number | null>(null);
    const [isTransitioning, setIsTransitioning] = useState(false);
    const [modalWidth, setModalWidth] = useState<number | undefined>(undefined);
    const [viewMode, setViewMode] = useState<'submitted' | 'activity'>('submitted');

    const messages = useMemo(() => {
        if (!currentMessage || !allMessages?.length) return [];
        return allMessages.filter(m => m.role === currentMessage.role).sort((a, b) => a.iterationNumber - b.iterationNumber);
    }, [allMessages, currentMessage]);

    const hasNavigation = messages.length > 1;
    const initialIndex = useMemo(() => (!hasNavigation || !currentMessage ? -1 : messages.findIndex(m => m.id === currentMessage.id)), [currentMessage, hasNavigation, messages]);
    const [activeIndex, setActiveIndex] = useState(initialIndex);

    useEffect(() => { setActiveIndex(initialIndex); }, [initialIndex]);

    const displayedMessage = hasNavigation && activeIndex >= 0 ? messages[activeIndex] : null;
    const submittedContent = displayedMessage?.content || content || 'No content available';
    const executionTraceText = displayedMessage?.executionTraceText || currentMessage?.executionTraceText;
    const displayIteration = displayedMessage?.iterationNumber;

    useEffect(() => { setViewMode('submitted'); }, [displayedMessage?.id, currentMessage?.id]);

    const navigateTo = (nextIndex: number) => {
        if (nextIndex === activeIndex || nextIndex < 0 || nextIndex >= messages.length) return;
        if (transitionTimeoutRef.current) window.clearTimeout(transitionTimeoutRef.current);
        setIsTransitioning(true);
        transitionTimeoutRef.current = window.setTimeout(() => {
            setActiveIndex(nextIndex);
            setIsTransitioning(false);
            transitionTimeoutRef.current = null;
        }, 150);
    };

    useEffect(() => {
        const handleKeydown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
            else if (hasNavigation && e.key === 'ArrowLeft') { e.preventDefault(); navigateTo(activeIndex - 1); }
            else if (hasNavigation && e.key === 'ArrowRight') { e.preventDefault(); navigateTo(activeIndex + 1); }
        };
        document.addEventListener('keydown', handleKeydown);
        return () => document.removeEventListener('keydown', handleKeydown);
    }, [activeIndex, hasNavigation, onClose]);

    useEffect(() => () => { if (transitionTimeoutRef.current) window.clearTimeout(transitionTimeoutRef.current); }, []);

    useLayoutEffect(() => {
        const handle = window.requestAnimationFrame(() => {
            const wrapper = contentWrapperRef.current;
            const modal = modalRef.current;
            if (!wrapper || !modal) return;
            const scrollWidth = wrapper.scrollWidth;
            setModalWidth(scrollWidth > modal.offsetWidth - 100 ? Math.min(scrollWidth + 100, window.innerWidth * 0.95, 1400) : undefined);
        });
        return () => window.cancelAnimationFrame(handle);
    }, [submittedContent]);

    const activityViewToggle = executionTraceText && (
        <div className="response-view-toggle" aria-label="Response view">
            <button type="button" className={`response-toggle-option ${viewMode === 'submitted' ? 'active' : ''}`} onClick={() => setViewMode('submitted')}>Artifact</button>
            <button type="button" className={`response-toggle-option ${viewMode === 'activity' ? 'active' : ''}`} onClick={() => setViewMode('activity')}>Agent Activity</button>
        </div>
    );

    const zIndex = document.getElementById('solution-modal-overlay') !== null ? 2200 : 1000;

    return (
        <div className="embedded-modal-overlay" style={{ position: 'fixed', pointerEvents: 'auto', zIndex }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
            <div ref={modalRef} className="embedded-modal-content" style={modalWidth ? { width: `${modalWidth}px` } : undefined}>
                <div className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div className="embedded-modal-header-left" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '.5rem' }}>
                        <div className="modal-title-row" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '.5rem' }}>
                            <h4 style={{ margin: 0 }}>{title}</h4>
                            {hasNavigation && displayIteration !== undefined && (
                                <span className="iteration-indicator" style={{ display: 'inline-flex' }}>{displayIteration}</span>
                            )}
                        </div>
                    </div>
                    <div className="embedded-modal-header-controls" style={{ display: 'flex', alignItems: 'center', gap: '.5rem', marginLeft: 'auto' }}>
                        {activityViewToggle}
                        {hasNavigation && (
                            <>
                                <button className="modal-nav-btn" data-nav="prev" disabled={activeIndex <= 0} title="Previous iteration" onClick={() => navigateTo(activeIndex - 1)}><Icon name="chevron_left" /></button>
                                <button className="modal-nav-btn" data-nav="next" disabled={activeIndex >= messages.length - 1} title="Next iteration" onClick={() => navigateTo(activeIndex + 1)}><Icon name="chevron_right" /></button>
                            </>
                        )}
                        <button className="close-modal-btn" onClick={onClose}><Icon name="close" /></button>
                    </div>
                </div>
                <div className="modal-body custom-scrollbar" style={{ opacity: isTransitioning ? 0.3 : 1 }}>
                    {viewMode === 'activity' && executionTraceText
                        ? <SandboxAgentActivity executionTraceText={executionTraceText} />
                        : <div ref={contentWrapperRef} className="modal-content-wrapper"><RenderMathMarkdown content={submittedContent} /></div>}
                </div>
            </div>
        </div>
    );
};

export function openEmbeddedModal(title: string, content: string, currentMessage?: ModalMessage, allMessages?: ModalMessage[]): void {
    if (!modalContainer) {
        modalContainer = document.createElement('div');
        modalContainer.id = 'embedded-modal-root';
        document.body.appendChild(modalContainer);
    }
    if (!modalRoot) modalRoot = createRoot(modalContainer);
    modalRoot.render(<EmbeddedModalViewer title={title} content={content} currentMessage={currentMessage} allMessages={allMessages} onClose={destroyModalRoot} />);
}

const rootMap = new WeakMap<HTMLElement, Root>();

function useSidebar() {
    const [isCollapsed, setIsCollapsed] = useState(false);

    useEffect(() => {
        const sidebar = document.getElementById('controls-sidebar');
        if (!sidebar) return;
        const check = () => setIsCollapsed(sidebar.classList.contains('collapsed'));
        check();
        const observer = new MutationObserver(check);
        observer.observe(sidebar, { attributes: true, attributeFilter: ['class'] });
        return () => observer.disconnect();
    }, []);

    const expandSidebar = useCallback(() => {
        const sidebar = document.getElementById('controls-sidebar');
        const expandButton = document.getElementById('sidebar-expand-button');
        if (sidebar) {
            sidebar.classList.remove('collapsed');
            if (expandButton) expandButton.style.display = 'none';
        }
    }, []);

    return { isCollapsed, expandSidebar };
}

const CurrentBestGenerationPanel: React.FC<{ content: string; state: ContextualState }> = ({ content, state }) => {
    const { isCollapsed: sidebarCollapsed, expandSidebar } = useSidebar();

    return (
        <div className="contextual-text-panel" style={{ flex: '1 1 0%', minWidth: 0, maxWidth: 'unset' }}>
            <div className="text-panel-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    {sidebarCollapsed && (
                        <>
                            <button
                                onClick={expandSidebar}
                                title="Expand Sidebar"
                                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-color)', opacity: 0.7, transition: 'opacity 0.2s ease', alignSelf: 'center', marginLeft: '0.5rem' }}
                                onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                                onMouseLeave={e => e.currentTarget.style.opacity = '0.7'}
                            >
                                <Icon name="dock_to_left" style={{ fontSize: '1.1rem', lineHeight: 1 }} />
                            </button>
                            <div style={{ width: '1px', alignSelf: 'stretch', background: 'linear-gradient(180deg, transparent 0%, rgba(var(--accent-purple-rgb), 0.35) 20%, rgba(var(--accent-purple-rgb), 0.35) 80%, transparent 100%)', opacity: 1, margin: '0 0.4rem' }} />
                        </>
                    )}
                    <h3 style={{ margin: 0, lineHeight: 1, display: 'flex', alignItems: 'center' }}>Current Artifact</h3>
                </div>
                <div className="text-panel-actions">
                    {state.id !== 'deepthink-branch-history' && (
                        <>
                            <button className="action-btn" onClick={() => openEmbeddedModal('Current Memory Document', state.currentMemory)} title="View current memory document" disabled={!state.currentMemory}><Icon name="pending" /> Memory</button>
                            <button className="action-btn" onClick={() => openEmbeddedModal('Structured Noise', state.currentStrategicPool)} title="View current structured noise" disabled={!state.currentStrategicPool}><Icon name="database" /> Structured Noise</button>
                            <button className="action-btn" onClick={() => openEmbeddedModal('Current Critique', state.currentBestSuggestions)} title="View current critique" disabled={!state.currentBestSuggestions}><Icon name="manage_search" /> Critique</button>
                        </>
                    )}
                    <button
                        className="action-btn"
                        onClick={async e => {
                            const icon = e.currentTarget.querySelector('.icon-slot');
                            try {
                                await navigator.clipboard.writeText(content);
                                if (icon) {
                                    const originalIcon = (icon as HTMLElement).dataset.iconName || 'content_copy';
                                    setIconSlot(icon, 'check');
                                    setTimeout(() => setIconSlot(icon, originalIcon), 1500);
                                }
                            } catch (err) {
                                console.error('Failed to copy:', err);
                            }
                        }}
                        title="Copy current text"
                        disabled={!content}
                    >
                        <Icon name="content_copy" />
                    </button>
                </div>
            </div>
            <div className="text-content-container custom-scrollbar">
                {content ? <RenderMathMarkdown content={content} /> : <div className="empty-state"><Icon name="smart_toy" className="empty-icon" /><p>Waiting for generation...</p></div>}
            </div>
        </div>
    );
};

const MinimalMessageCard: React.FC<{ message: ContextualMessage; allMessages: ContextualMessage[] }> = ({ message, allMessages }) => {
    const getRoleLabel = (role: string) => {
        if (role === 'main_generator') return message.id === allMessages.find(m => m.role === 'main_generator')?.id ? 'Execution' : 'Correction';
        if (role === 'iterative_agent') return 'Solution Critique';
        if (role === 'memory_agent') return 'Memory';
        if (role === 'strategic_pool_agent') return 'Structured Noise';
        if (role === 'system') return 'System';
        return role;
    };

    const roleIconMap: Record<string, string> = {
        main_generator: 'check',
        iterative_agent: 'manage_search',
        memory_agent: 'pending',
        strategic_pool_agent: 'database',
        system: 'smart_toy',
    };
    const roleClassMap: Record<string, string> = {
        main_generator: 'main-generator-card',
        iterative_agent: 'iterative-agent-card',
        memory_agent: 'memory-agent-card',
        strategic_pool_agent: 'strategic-pool-agent-card',
        system: 'system-card',
    };

    const roleClass = (roleClassMap[message.role] || '') + (message.status ? ` status-${message.status}` : '');

    return (
        <div className={`minimal-message-card ${roleClass}`}>
            <div className="minimal-card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <Icon name={roleIconMap[message.role] || 'smart_toy'} className="card-icon" />
                    <span className="card-title">{getRoleLabel(message.role)}</span>
                    <span className="card-iteration">{message.iterationNumber}</span>
                </div>
                <button className="action-btn" onClick={() => openEmbeddedModal(getRoleLabel(message.role), message.content, message, allMessages)} title="View full response">
                    <Icon name="visibility" /> View
                </button>
            </div>
            <div className="minimal-card-content scrollbar-compact">
                <RenderMathMarkdown content={message.content} />
            </div>
        </div>
    );
};

function ContextualUI({ state, onStop }: { state: ContextualState; onStop: () => void }) {
    return (
        <div className="contextual-ui-container" style={{ display: 'flex', height: '100%', padding: '6px', gap: '8px', boxSizing: 'border-box', width: '100%', maxWidth: '100%', overflow: 'hidden' }}>
            <CurrentBestGenerationPanel content={state.currentBestGeneration} state={state} />
            <SharedAgentActivityPanel
                title="Agent Activity"
                isProcessing={state.isProcessing}
                error={state.error || null}
                onStop={onStop}
                headerExtra={<span className="iteration-badge">{state.iterationCount}</span>}
                className="contextual-agent-panel"
                style={{ flex: '0 0 32%', minWidth: 0, maxWidth: '32%' }}
            >
                {state.messages.map(message => <MinimalMessageCard key={message.id} message={message} allMessages={state.messages} />)}
            </SharedAgentActivityPanel>
        </div>
    );
}

export function renderContextualUI(container: HTMLElement, state: ContextualState, onStop: () => void): Root {
    let root = rootMap.get(container);
    if (!root) {
        root = createRoot(container);
        rootMap.set(container, root);
    }
    flushSync(() => root.render(<ContextualUI state={state} onStop={onStop} />));
    return root;
}

export function updateContextualUI(root: any, state: ContextualState, onStop: () => void): void {
    if (!root) return;
    flushSync(() => root.render(<ContextualUI state={state} onStop={onStop} />));
}

export function renderBranchHistoryUI(
    container: HTMLElement,
    originalSolution: string,
    finalSolution: string,
    iterations: Array<{
        iterationNumber: number;
        critique: string;
        critiqueExecutionTraceText?: string;
        correctedSolution: string;
        correctedSolutionExecutionTraceText?: string;
        timestamp?: number;
    }>,
    isProcessing?: boolean
): any {
    const messages: ContextualMessage[] = [];
    const safeIterations = iterations || [];

    safeIterations.forEach((iter, index) => {
        const baseTimestamp = iter.timestamp || (Date.now() + index * 1000);
        if (iter.correctedSolution) {
            messages.push({
                id: `correction-iter-${iter.iterationNumber}`,
                role: 'main_generator',
                content: iter.correctedSolution,
                timestamp: baseTimestamp,
                iterationNumber: iter.iterationNumber,
                executionTraceText: iter.correctedSolutionExecutionTraceText,
            });
        }
        if (iter.critique) {
            messages.push({
                id: `critique-iter-${iter.iterationNumber}`,
                role: 'iterative_agent',
                content: iter.critique,
                timestamp: baseTimestamp + 500,
                iterationNumber: iter.iterationNumber,
                executionTraceText: iter.critiqueExecutionTraceText,
            });
        }
    });

    const contentHistory: Array<{ content: string; title: string; timestamp: number }> = [];
    if (originalSolution) {
        contentHistory.push({
            content: originalSolution,
            title: 'Original Solution (Iteration 0)',
            timestamp: safeIterations[0]?.timestamp ? safeIterations[0].timestamp - 1000 : Date.now() - 1000,
        });
    }
    safeIterations.forEach((iter, index) => {
        contentHistory.push({
            content: iter.correctedSolution,
            title: `Iteration ${iter.iterationNumber} - Corrected Solution`,
            timestamp: iter.timestamp || (Date.now() + index * 1000),
        });
    });
    if (finalSolution && (safeIterations.length === 0 || finalSolution !== safeIterations[safeIterations.length - 1]?.correctedSolution)) {
        contentHistory.push({ content: finalSolution, title: 'Final Solution', timestamp: Date.now() });
    }

    const mockState: ContextualState = {
        id: 'deepthink-branch-history',
        initialUserRequest: '',
        initialMainGeneration: safeIterations[0]?.correctedSolution || originalSolution || 'Processing...',
        currentBestGeneration: finalSolution || 'Processing branch corrections...',
        currentBestSuggestions: '',
        allIterativeSuggestions: [],
        mainGeneratorHistory: [],
        iterativeAgentHistory: [],
        memoryAgentHistory: [],
        strategicPoolAgentHistory: [],
        messages,
        iterationCount: safeIterations.length,
        isRunning: false,
        isProcessing: isProcessing !== undefined ? isProcessing : safeIterations.length === 0,
        contentHistory,
        currentMemory: '',
        memorySnapshots: [],
        currentStrategicPool: '',
        allStrategicPools: [],
    };

    return renderContextualUI(container, mockState, () => {});
}

let contextualUIRoot: Root | null = null;
let activeContextualContainer: HTMLElement | null = null;

setContextualStateUpdateCallback((state: ContextualState) => {
    if (contextualUIRoot && activeContextualContainer && activeContextualContainer.isConnected) {
        updateContextualUI(contextualUIRoot, state, stopContextualProcess);
    } else {
        renderContextualMode();
    }
});

function createIdleContextualState(): ContextualState {
    return {
        id: 'contextual-idle',
        initialUserRequest: '',
        initialMainGeneration: '',
        currentBestGeneration: '',
        currentBestSuggestions: '',
        allIterativeSuggestions: [],
        mainGeneratorHistory: [],
        iterativeAgentHistory: [],
        memoryAgentHistory: [],
        strategicPoolAgentHistory: [],
        currentMemory: '',
        memorySnapshots: [],
        currentStrategicPool: '',
        allStrategicPools: [],
        iterationCount: 0,
        isProcessing: false,
        isRunning: false,
        error: null,
        messages: [],
        contentHistory: [],
    };
}

export function renderContextualMode() {
    const container = document.getElementById('pipelines-content-container');
    const tabsContainer = document.getElementById('tabs-nav-container');
    const mainHeaderContent = document.querySelector('.main-header-content') as HTMLElement | null;
    if (!container || !tabsContainer) return;

    if (contextualUIRoot) {
        contextualUIRoot.unmount();
        contextualUIRoot = null;
    }

    tabsContainer.innerHTML = '';
    container.innerHTML = '';
    if (mainHeaderContent) mainHeaderContent.style.display = 'none';

    const contextualContainer = document.createElement('div');
    contextualContainer.id = 'contextual-container';
    contextualContainer.className = 'pipeline-content active contextual-mode-container';
    contextualContainer.style.height = '100%';
    container.appendChild(contextualContainer);
    activeContextualContainer = contextualContainer;

    const state = getContextualState() || createIdleContextualState();
    contextualUIRoot = renderContextualUI(contextualContainer, state, stopContextualProcess);
}
