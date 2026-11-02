import React, { useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { rust } from '@codemirror/lang-rust';
import { cpp } from '@codemirror/lang-cpp';
import { go } from '@codemirror/lang-go';
import { yaml } from '@codemirror/lang-yaml';
import { sql } from '@codemirror/lang-sql';
import { StreamLanguage } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { Icon } from '../../UI/Icons';
import RenderMathMarkdown from '../../Styles/Components/RenderMathMarkdown';

export interface SplitDiffRow {
    left?: { lineNumber?: number; content: string; type: 'delete' | 'normal' };
    right?: { lineNumber?: number; content: string; type: 'add' | 'normal' };
}

export interface GitDiffHunk {
    header: string;
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    splitRows: SplitDiffRow[];
}

export interface GitDiffFile {
    id: string;
    displayPath: string;
    hunks: GitDiffHunk[];
}

export function isHiddenPath(filePath: string): boolean {
    if (!filePath) return false;
    return filePath.split('/').some(segment => segment.startsWith('.') || segment === '__pycache__' || segment === 'node_modules');
}

export function parseGitDiff(raw: string): GitDiffFile[] {
    if (!raw?.trim()) return [];
    const files: GitDiffFile[] = [];
    const lines = raw.split(/\r?\n/);
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        if (line.startsWith('diff --git ')) {
            const parts = line.slice(11).split(' ');
            let oldPath = parts[0]?.replace(/^[ab]\//, '') || '';
            let newPath = parts[1]?.replace(/^[ab]\//, '') || oldPath;
            let displayPath = newPath || oldPath;

            i++;
            while (i < lines.length && !lines[i].startsWith('diff --git ') && !lines[i].startsWith('@@ ')) {
                const headerLine = lines[i];
                if (headerLine.startsWith('deleted file mode')) displayPath = oldPath;
                else if (headerLine.startsWith('rename to ')) displayPath = headerLine.slice(10).trim();
                else if (headerLine.startsWith('--- ')) {
                    const p = headerLine.slice(4).trim();
                    if (p !== '/dev/null') oldPath = p.replace(/^[ab]\//, '');
                } else if (headerLine.startsWith('+++ ')) {
                    const p = headerLine.slice(4).trim();
                    if (p === '/dev/null') displayPath = oldPath;
                    else newPath = p.replace(/^[ab]\//, '');
                }
                i++;
            }

            if (isHiddenPath(displayPath) || isHiddenPath(oldPath)) {
                while (i < lines.length && !lines[i].startsWith('diff --git ')) i++;
                continue;
            }

            const hunks: GitDiffHunk[] = [];
            while (i < lines.length && !lines[i].startsWith('diff --git ')) {
                if (lines[i].startsWith('@@ ')) {
                    const m = lines[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/);
                    if (!m) { i++; continue; }
                    const oldStart = parseInt(m[1], 10);
                    const oldLines = m[2] !== undefined ? parseInt(m[2], 10) : 1;
                    const newStart = parseInt(m[3], 10);
                    const newLines = m[4] !== undefined ? parseInt(m[4], 10) : 1;
                    const header = lines[i];
                    let curOld = oldStart, curNew = newStart;
                    const hunkRawLines: Array<{ prefix: string; text: string; oldNo?: number; newNo?: number }> = [];

                    i++;
                    while (i < lines.length && !lines[i].startsWith('@@ ') && !lines[i].startsWith('diff --git ')) {
                        const hl = lines[i];
                        if (!hl.startsWith('\\')) {
                            const prefix = hl.charAt(0);
                            const text = hl.slice(1);
                            if (prefix === '+') hunkRawLines.push({ prefix: '+', text, newNo: curNew++ });
                            else if (prefix === '-') hunkRawLines.push({ prefix: '-', text, oldNo: curOld++ });
                            else hunkRawLines.push({ prefix: ' ', text, oldNo: curOld++, newNo: curNew++ });
                        }
                        i++;
                    }

                    const splitRows: SplitDiffRow[] = [];
                    let pendingDeletes: Array<{ no: number; text: string }> = [];
                    let pendingAdds: Array<{ no: number; text: string }> = [];

                    const flushPending = () => {
                        const count = Math.max(pendingDeletes.length, pendingAdds.length);
                        for (let k = 0; k < count; k++) {
                            splitRows.push({
                                left: pendingDeletes[k] ? { lineNumber: pendingDeletes[k].no, content: pendingDeletes[k].text, type: 'delete' } : undefined,
                                right: pendingAdds[k] ? { lineNumber: pendingAdds[k].no, content: pendingAdds[k].text, type: 'add' } : undefined,
                            });
                        }
                        pendingDeletes = [];
                        pendingAdds = [];
                    };

                    for (const r of hunkRawLines) {
                        if (r.prefix === '-') pendingDeletes.push({ no: r.oldNo!, text: r.text });
                        else if (r.prefix === '+') pendingAdds.push({ no: r.newNo!, text: r.text });
                        else {
                            flushPending();
                            splitRows.push({
                                left: { lineNumber: r.oldNo, content: r.text, type: 'normal' },
                                right: { lineNumber: r.newNo, content: r.text, type: 'normal' },
                            });
                        }
                    }
                    flushPending();
                    hunks.push({ header, oldStart, oldLines, newStart, newLines, splitRows });
                } else {
                    i++;
                }
            }
            files.push({ id: `${oldPath}:${newPath}`, displayPath, hunks });
        } else {
            i++;
        }
    }
    return files;
}

const GitDiffView: React.FC<{ diff: string }> = ({ diff }) => {
    const parsedFiles = useMemo(() => parseGitDiff(diff), [diff]);

    if (!diff?.trim() || parsedFiles.length === 0) {
        return (
            <div className="git-diff-view custom-scrollbar">
                <div className="git-diff-empty-state">
                    <p>No changes between selected snapshots.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="git-diff-view custom-scrollbar">
            <div className="git-diff-container">
                {parsedFiles.map(file => (
                    <section key={file.id} className="git-diff-file-section">
                        <div className="git-diff-file-header">
                            <Icon name="file" />
                            <span className="git-diff-file-path">{file.displayPath}</span>
                        </div>
                        {file.hunks.length === 0 ? (
                            <div className="git-diff-empty-hunk">No text differences to display.</div>
                        ) : (
                            <table className="git-diff-split-table">
                                <tbody>
                                    {file.hunks.map((hunk, hIdx) => (
                                        <React.Fragment key={hIdx}>
                                            {hIdx > 0 && (
                                                <tr className="git-diff-divider-row">
                                                    <td colSpan={2} className="git-diff-divider-cell"><span>···</span></td>
                                                </tr>
                                            )}
                                            {hunk.splitRows.map((row, rIdx) => (
                                                <tr key={rIdx} className="git-diff-split-row">
                                                    <td className={`git-diff-col-side ${row.left ? `git-diff-cell-${row.left.type}` : 'git-diff-cell-empty'}`}>
                                                        <div className="git-diff-side-inner">
                                                            <span className="git-diff-line-number">{row.left?.lineNumber ?? ''}</span>
                                                            <span className="git-diff-line-code">{row.left?.content ?? ''}</span>
                                                        </div>
                                                    </td>
                                                    <td className={`git-diff-col-side ${row.right ? `git-diff-cell-${row.right.type}` : 'git-diff-cell-empty'}`}>
                                                        <div className="git-diff-side-inner">
                                                            <span className="git-diff-line-number">{row.right?.lineNumber ?? ''}</span>
                                                            <span className="git-diff-line-code">{row.right?.content ?? ''}</span>
                                                        </div>
                                                    </td>
                                                </tr>
                                            ))}
                                        </React.Fragment>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </section>
                ))}
            </div>
        </div>
    );
};

interface CommitItem { hash: string; date: string; message: string; }
interface FileItem { path: string; size: number; mtime: number; }
interface TreeFolder { name: string; type: 'folder'; children: Record<string, TreeNode>; }
interface TreeFile { name: string; type: 'file'; path: string; size: number; mtime: number; }
type TreeNode = TreeFolder | TreeFile;
type ExplorerView = 'file' | 'diff';

const IGNORED_NAMES = new Set([
    'venv', 'env', '.venv', 'node_modules', '__pycache__', '.git', '.cache',
    '.local', '.matplotlib', '.python_user_base', '.ipynb_checkpoints', '.tmp',
]);

function getMediaFileType(filename: string): 'image' | 'video' | 'audio' | 'pdf' | null {
    const ext = filename.split('.').pop()?.toLowerCase();
    if (!ext) return null;
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'].includes(ext)) return 'image';
    if (['mp4', 'webm', 'ogg'].includes(ext)) return 'video';
    if (['mp3', 'wav'].includes(ext)) return 'audio';
    return ext === 'pdf' ? 'pdf' : null;
}

function buildFileTree(files: FileItem[], stripPrefix = ''): TreeFolder {
    const root: TreeFolder = { name: '', type: 'folder', children: {} };
    for (const file of files) {
        const displayPath = stripPrefix && file.path.startsWith(`${stripPrefix}/`)
            ? file.path.slice(stripPrefix.length + 1)
            : file.path;
        const parts = displayPath.split('/');
        if (parts.some(part => part.startsWith('.') || IGNORED_NAMES.has(part.toLowerCase()))) continue;

        let current = root;
        parts.forEach((part, index) => {
            if (index === parts.length - 1) {
                current.children[part] = { name: part, type: 'file', path: file.path, size: file.size, mtime: file.mtime };
                return;
            }
            if (!current.children[part] || current.children[part].type !== 'folder') {
                current.children[part] = { name: part, type: 'folder', children: {} };
            }
            current = current.children[part] as TreeFolder;
        });
    }
    return root;
}

function getLanguageExtension(filename: string) {
    const ext = filename.split('.').pop()?.toLowerCase();
    switch (ext) {
        case 'js': case 'jsx': case 'ts': case 'tsx': return [javascript()];
        case 'py': return [python()];
        case 'css': return [css()];
        case 'html': case 'htm': return [html()];
        case 'json': case 'jsonl': return [json()];
        case 'md': return [markdown()];
        case 'rs': return [rust()];
        case 'c': case 'cpp': case 'h': case 'hpp': case 'cc': return [cpp()];
        case 'go': return [go()];
        case 'yaml': case 'yml': return [yaml()];
        case 'sql': return [sql()];
        case 'sh': case 'bash': case 'zsh': return [StreamLanguage.define(shell)];
        default:
            return filename.toLowerCase().endsWith('rc') || filename.toLowerCase().includes('profile')
                ? [StreamLanguage.define(shell)]
                : [];
    }
}

export const DeepthinkFilesystemTab: React.FC<{ repositoryId: string }> = ({ repositoryId }) => {
    const [history, setHistory] = useState<CommitItem[]>([]);
    const [selectedCommit, setSelectedCommit] = useState('current');
    const [compareBase, setCompareBase] = useState('current');
    const [compareHead, setCompareHead] = useState('current');
    const [files, setFiles] = useState<FileItem[]>([]);
    const [selectedFile, setSelectedFile] = useState('');
    const [fileContent, setFileContent] = useState('');
    const [diffContent, setDiffContent] = useState('');
    const [view, setView] = useState<ExplorerView>('file');
    const [isTreeLoading, setIsTreeLoading] = useState(false);
    const [isContentLoading, setIsContentLoading] = useState(false);
    const [isDiffLoading, setIsDiffLoading] = useState(false);
    const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({});
    const [markdownMode, setMarkdownMode] = useState<'preview' | 'raw'>('preview');
    const [theme, setTheme] = useState<'light' | 'dark'>(() => document.body.classList.contains('light-mode') ? 'light' : 'dark');
    const treeRequest = useRef(0);

    const fetchFileTree = async (id: string, commit: string) => {
        const requestId = ++treeRequest.current;
        setIsTreeLoading(true);
        try {
            const response = await fetch(`/api/sandbox/workspace/files?repositoryId=${encodeURIComponent(id)}&commit=${encodeURIComponent(commit)}&scope=repository`);
            if (!response.ok || requestId !== treeRequest.current) return;
            const nextFiles = await response.json() as FileItem[];
            if (requestId !== treeRequest.current) return;
            setFiles(nextFiles);
            setSelectedFile(current => {
                if (current && nextFiles.some(file => file.path === current)) return current;
                setFileContent('');
                return '';
            });
        } catch (error) {
            console.error('Failed to load repository tree:', error);
        } finally {
            if (requestId === treeRequest.current) setIsTreeLoading(false);
        }
    };

    const fetchHistory = async (id: string) => {
        try {
            const response = await fetch(`/api/sandbox/workspace/history?repositoryId=${encodeURIComponent(id)}`);
            if (!response.ok) return;
            const nextHistory = await response.json() as CommitItem[];
            setHistory(nextHistory);
            setCompareBase(current => current === 'current' && nextHistory.length ? nextHistory[nextHistory.length - 1].hash : current);
        } catch (error) {
            console.error('Failed to load Results repository history:', error);
        }
    };

    const fetchFileContent = async (id: string, filePath: string, commit: string) => {
        setIsContentLoading(true);
        try {
            const response = await fetch(`/api/sandbox/workspace/file?repositoryId=${encodeURIComponent(id)}&path=${encodeURIComponent(filePath)}&commit=${encodeURIComponent(commit)}&scope=repository`);
            setFileContent(response.ok ? await response.text() : 'This file does not exist in the selected snapshot.');
        } catch (error) {
            console.error('Failed to load Results repository file:', error);
            setFileContent('Failed to load file content.');
        } finally {
            setIsContentLoading(false);
        }
    };

    const fetchDiff = async (id: string, base: string, head: string) => {
        if (!id) return;
        setIsDiffLoading(true);
        try {
            const response = await fetch(`/api/sandbox/workspace/diff?repositoryId=${encodeURIComponent(id)}&base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}`);
            setDiffContent(response.ok ? (await response.text() || '') : '');
        } catch (error) {
            console.error('Failed to compare Results repository snapshots:', error);
            setDiffContent('');
        } finally {
            setIsDiffLoading(false);
        }
    };

    const handleOpenCompare = () => {
        if (!history.length) return;
        const currentHead = selectedCommit;
        const currentBase = compareBase !== 'current' && compareBase !== currentHead
            ? compareBase
            : (history.length > 1 ? history[history.length - 1].hash : (history[0]?.hash || 'current'));
        setCompareHead(currentHead);
        setCompareBase(currentBase);
        setView('diff');
    };

    const handleOpenDirectory = async () => {
        if (!repositoryId) return;
        try {
            const mod = await import('../../Core/SandboxToolRuntime');
            await mod.openSandboxRepositoryDirectory(repositoryId);
        } catch (error) {
            console.warn('Could not open directory in file manager:', error);
        }
    };

    useEffect(() => {
        const observer = new MutationObserver(() => setTheme(document.body.classList.contains('light-mode') ? 'light' : 'dark'));
        observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        const container = document.getElementById('pipelines-content-container');
        container?.classList.add('filesystem-active');
        return () => container?.classList.remove('filesystem-active');
    }, []);

    useEffect(() => {
        setSelectedCommit('current');
        setCompareBase('current');
        setCompareHead('current');
        setSelectedFile('');
        setFileContent('');
        setDiffContent('');
        setView('file');
        setFiles([]);
        if (repositoryId) void fetchHistory(repositoryId);
    }, [repositoryId]);

    useEffect(() => {
        const onSnapshot = (event: Event) => {
            const id = (event as CustomEvent<{ repositoryId?: string }>).detail?.repositoryId;
            if (id && id === repositoryId) {
                void fetchHistory(id);
                void fetchFileTree(id, selectedCommit);
                if (view === 'diff') void fetchDiff(id, compareBase, compareHead);
            }
        };
        window.addEventListener('deepthinkResultsSnapshot', onSnapshot);
        return () => window.removeEventListener('deepthinkResultsSnapshot', onSnapshot);
    }, [repositoryId, selectedCommit, view, compareBase, compareHead]);

    useEffect(() => {
        if (repositoryId) void fetchFileTree(repositoryId, selectedCommit);
    }, [repositoryId, selectedCommit]);

    useEffect(() => {
        if (repositoryId && view === 'diff') void fetchDiff(repositoryId, compareBase, compareHead);
    }, [repositoryId, compareBase, compareHead, view]);

    useEffect(() => {
        if (!repositoryId || !selectedFile || view !== 'file') return;
        if (getMediaFileType(selectedFile)) {
            setFileContent('');
            return;
        }
        void fetchFileContent(repositoryId, selectedFile, selectedCommit);
    }, [repositoryId, selectedFile, selectedCommit, view]);

    const toggleFolder = (folderPath: string) => {
        setCollapsedFolders(current => ({ ...current, [folderPath]: !(current[folderPath] !== false) }));
    };

    const renderTreeNodes = (node: TreeNode, parentPath = ''): React.ReactNode => {
        if (node.type !== 'folder') return null;
        const names = Object.keys(node.children).sort((left, right) => {
            const a = node.children[left];
            const b = node.children[right];
            if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
            return left.localeCompare(right);
        });
        return names.map(name => {
            const child = node.children[name];
            const currentPath = parentPath ? `${parentPath}/${name}` : name;
            if (child.type === 'folder') {
                const isCollapsed = collapsedFolders[currentPath] !== false;
                return (
                    <div key={currentPath} className="tree-folder-wrapper">
                        <button className="tree-node tree-folder" type="button" onClick={() => toggleFolder(currentPath)}>
                            <span className={`tree-chevron ${isCollapsed ? '' : 'is-open'}`}><Icon name="chevron_right" /></span>
                            <Icon name="folder" />
                            <span className="tree-label">{child.name}</span>
                        </button>
                        {!isCollapsed && <div className="tree-folder-children">{renderTreeNodes(child, currentPath)}</div>}
                    </div>
                );
            }
            return (
                <button
                    key={currentPath}
                    className={`tree-node tree-file ${selectedFile === child.path && view === 'file' ? 'selected' : ''}`}
                    type="button"
                    onClick={() => { setSelectedFile(child.path); setView('file'); }}
                >
                    <span className="tree-file-spacer" />
                    <Icon name="file" />
                    <span className="tree-label">{child.name}</span>
                </button>
            );
        });
    };

    const revisionOptions = (
        <>
            <option value="current">Current snapshot</option>
            {history.map(commit => (
                <option key={commit.hash} value={commit.hash}>
                    {commit.message} · {commit.hash.slice(0, 7)}
                </option>
            ))}
        </>
    );

    const fileTree = buildFileTree(files);
    const mediaType = selectedFile ? getMediaFileType(selectedFile) : null;
    const isMarkdown = Boolean(selectedFile && /\.(md|markdown|mdown|mkdn)$/i.test(selectedFile));
    const fileUrl = selectedFile
        ? `/api/sandbox/workspace/file?repositoryId=${encodeURIComponent(repositoryId)}&path=${encodeURIComponent(selectedFile)}&commit=${encodeURIComponent(selectedCommit)}&scope=repository`
        : '';

    return (
        <div className="vfs-filesystem-tab">
            <div className="vfs-modal-body">
                {!repositoryId ? (
                    <div className="vfs-empty-state">
                        <h3>No Deepthink Results Repository</h3>
                        <p>Start a sandboxed Deepthink run to create and inspect its Results repository.</p>
                    </div>
                ) : (
                    <div className="vfs-split-layout">
                        <aside className="vfs-sidebar">
                            <div className="vfs-sidebar-title">Files</div>
                            <div className="vfs-tree-container custom-scrollbar">
                                {isTreeLoading && !files.length ? (
                                    <div className="vfs-tree-empty">Loading…</div>
                                ) : files.length ? (
                                    renderTreeNodes(fileTree)
                                ) : (
                                    <div className="vfs-tree-empty">No files in this snapshot</div>
                                )}
                            </div>
                            <div className="vfs-sidebar-footer">
                                <div className="vfs-sidebar-footer-row">
                                    <div className="vfs-agent-select-wrapper" style={{ width: '100%' }}>
                                        <select
                                            aria-label="Browse repository snapshot"
                                            title="Browse repository snapshot"
                                            value={selectedCommit}
                                            onChange={event => {
                                                setSelectedCommit(event.target.value);
                                                setView('file');
                                            }}
                                            className="vfs-agent-select"
                                        >
                                            {revisionOptions}
                                        </select>
                                        <span className="vfs-select-arrow"><Icon name="chevron_down" /></span>
                                    </div>
                                </div>
                                <div className="vfs-sidebar-footer-row">
                                    <button
                                        className="vfs-compare-trigger-footer"
                                        type="button"
                                        onClick={handleOpenCompare}
                                        disabled={!history.length}
                                        title="Compare repository snapshots"
                                    >
                                        <Icon name="compare" /> <span>Compare</span>
                                    </button>
                                    <button
                                        className="vfs-filemanager-btn-footer"
                                        type="button"
                                        title="Open repository folder in file manager"
                                        onClick={() => void handleOpenDirectory()}
                                        disabled={!repositoryId}
                                    >
                                        <Icon name="folder" />
                                    </button>
                                </div>
                            </div>
                        </aside>
                        <main className="vfs-editor-area">
                            {view === 'diff' ? (
                                <div className="vfs-editor-wrapper">
                                    <div className="vfs-editor-header">
                                        <div className="vfs-file-info">
                                            <Icon name="compare" />
                                            <div className="vfs-compare-select-wrapper">
                                                <select
                                                    value={compareBase}
                                                    onChange={e => setCompareBase(e.target.value)}
                                                    className="vfs-compare-select"
                                                    title="Base snapshot"
                                                >
                                                    {revisionOptions}
                                                </select>
                                                <span className="vfs-select-arrow"><Icon name="chevron_down" /></span>
                                            </div>
                                            <span className="vfs-compare-arrow">→</span>
                                            <div className="vfs-compare-select-wrapper">
                                                <select
                                                    value={compareHead}
                                                    onChange={e => setCompareHead(e.target.value)}
                                                    className="vfs-compare-select"
                                                    title="Compare snapshot"
                                                >
                                                    {revisionOptions}
                                                </select>
                                                <span className="vfs-select-arrow"><Icon name="chevron_down" /></span>
                                            </div>
                                        </div>
                                    </div>
                                    {isDiffLoading ? (
                                        <div className="vfs-code-loading">Loading diff comparison…</div>
                                    ) : (
                                        <GitDiffView diff={diffContent} />
                                    )}
                                </div>
                            ) : selectedFile ? (
                                <div className="vfs-editor-wrapper">
                                    <div className="vfs-editor-header">
                                        <div className="vfs-file-info">
                                            <Icon name="file" />
                                            <span className="vfs-file-path">{selectedFile}</span>
                                        </div>
                                        {isMarkdown && (
                                            <div className="response-view-toggle" aria-label="Markdown view mode">
                                                <button
                                                    type="button"
                                                    className={`response-toggle-option ${markdownMode === 'preview' ? 'active' : ''}`}
                                                    onClick={() => setMarkdownMode('preview')}
                                                >
                                                    Preview
                                                </button>
                                                <button
                                                    type="button"
                                                    className={`response-toggle-option ${markdownMode === 'raw' ? 'active' : ''}`}
                                                    onClick={() => setMarkdownMode('raw')}
                                                >
                                                    Source
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                    {isContentLoading ? (
                                        <div className="vfs-code-loading">Loading file…</div>
                                    ) : mediaType === 'image' ? (
                                        <div className="vfs-code-viewport custom-scrollbar has-media">
                                            <div className="vfs-media-preview img-preview"><img src={fileUrl} alt={selectedFile} /></div>
                                        </div>
                                    ) : mediaType === 'video' ? (
                                        <div className="vfs-code-viewport custom-scrollbar has-media">
                                            <div className="vfs-media-preview video-preview"><video src={fileUrl} controls /></div>
                                        </div>
                                    ) : mediaType === 'audio' ? (
                                        <div className="vfs-code-viewport custom-scrollbar has-media">
                                            <div className="vfs-media-preview audio-preview"><audio src={fileUrl} controls /></div>
                                        </div>
                                    ) : mediaType === 'pdf' ? (
                                        <div className="vfs-code-viewport custom-scrollbar">
                                            <iframe src={fileUrl} title={selectedFile} className="vfs-pdf-preview" />
                                        </div>
                                    ) : isMarkdown && markdownMode === 'preview' ? (
                                        <div className="vfs-markdown-wrapper custom-scrollbar">
                                            <RenderMathMarkdown content={fileContent} />
                                        </div>
                                    ) : (
                                        <div className="vfs-code-viewport custom-scrollbar">
                                            <CodeMirror
                                                key={`${selectedCommit}:${selectedFile}`}
                                                value={fileContent}
                                                height="100%"
                                                extensions={getLanguageExtension(selectedFile)}
                                                readOnly
                                                theme={theme}
                                                className="vfs-codemirror-wrapper"
                                            />
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div className="vfs-editor-placeholder">
                                    <h3>No File Selected</h3>
                                    <p>Expand a folder and select a file.</p>
                                </div>
                            )}
                        </main>
                    </div>
                )}
            </div>
        </div>
    );
};
