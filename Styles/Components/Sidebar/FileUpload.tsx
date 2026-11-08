import React, { useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { getEncoding } from 'js-tiktoken';
import { Icon } from '../../../UI/Icons';
import { getProviderForCurrentModel, getRoutingManager, getSelectedModel } from '../../../Routing';
import { FileData } from '../../../Core/Types';
import { globalState } from '../../../Core/State';

interface FileTypeConfig {
    icon: string;
    color: string;
    label: string;
}

const FILE_TYPE_CONFIG: Record<string, FileTypeConfig> = {
    'image/png': { icon: 'image', color: '#10b981', label: 'PNG' },
    'image/jpeg': { icon: 'image', color: '#10b981', label: 'JPG' },
    'image/gif': { icon: 'gif', color: '#8b5cf6', label: 'GIF' },
    'image/webp': { icon: 'image', color: '#10b981', label: 'WEBP' },
    'text/plain': { icon: 'description', color: '#6b7280', label: 'TXT' },
    'text/markdown': { icon: 'article', color: '#64748b', label: 'MD' },
    'text/html': { icon: 'code', color: '#f97316', label: 'HTML' },
    'text/csv': { icon: 'table_chart', color: '#22c55e', label: 'CSV' },
    'text/x-python': { icon: 'code', color: '#3776ab', label: 'PY' },
    'application/x-python': { icon: 'code', color: '#3776ab', label: 'PY' },
    'text/javascript': { icon: 'javascript', color: '#f7df1e', label: 'JS' },
    'application/javascript': { icon: 'javascript', color: '#f7df1e', label: 'JS' },
    'text/x-c++src': { icon: 'code', color: '#00599c', label: 'CPP' },
    'application/json': { icon: 'data_object', color: '#6b7280', label: 'JSON' },
};

const TEXT_FILE_EXTENSIONS = [
    '.txt', '.md', '.mdx', '.markdown', '.rst', '.adoc', '.asciidoc', '.log',
    '.html', '.htm', '.css', '.scss', '.sass', '.less', '.xml', '.tex', '.bib',
    '.csv', '.tsv', '.json', '.jsonc', '.json5', '.ipynb', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.properties', '.env', '.gitignore',
    '.py', '.pyi', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx',
    '.c', '.h', '.cc', '.cp', '.cpp', '.cxx', '.c++', '.hpp', '.hxx',
    '.rs', '.go', '.java', '.kt', '.kts', '.swift', '.cs', '.fs', '.fsx', '.vb',
    '.php', '.rb', '.rake', '.pl', '.pm', '.r', '.lua', '.dart', '.ex', '.exs',
    '.erl', '.hrl', '.hs', '.lhs', '.clj', '.cljs', '.cljc', '.scala', '.sc', '.groovy',
    '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd', '.sql', '.graphql', '.gql',
    '.proto', '.sol', '.vue', '.svelte', '.astro', '.prisma', '.tf', '.hcl', '.dockerfile',
    '.asm', '.s', '.v', '.sv', '.vhd', '.vhdl', '.make', '.mk'
] as const;

const TEXT_EXTENSION_SET = new Set<string>(TEXT_FILE_EXTENSIONS);
const TEXT_FILE_NAMES = new Set(['dockerfile', 'makefile', 'rakefile', 'gemfile', 'procfile', 'jenkinsfile']);
const REMOVED_BINARY_EXTENSIONS = new Set([
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.mp4', '.m4v', '.mov', '.webm', '.avi', '.mkv', '.wmv', '.flv', '.mpeg', '.mpg', '.3gp',
    '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.wma', '.aiff', '.opus',
]);
const REMOVED_BINARY_MIME_TYPES = new Set([
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const TEXT_MIME_BY_EXTENSION: Record<string, string> = {
    '.json': 'application/json', '.jsonc': 'application/json', '.json5': 'application/json',
    '.csv': 'text/csv', '.html': 'text/html', '.htm': 'text/html',
    '.md': 'text/markdown', '.mdx': 'text/markdown', '.markdown': 'text/markdown',
    '.py': 'text/x-python', '.pyi': 'text/x-python',
    '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript', '.jsx': 'text/javascript',
    '.cpp': 'text/x-c++src', '.cc': 'text/x-c++src', '.cp': 'text/x-c++src', '.cxx': 'text/x-c++src', '.c++': 'text/x-c++src',
};

const ACCEPTED_FILES = ['image/*', 'text/*', ...TEXT_FILE_EXTENSIONS].join(',');
const SIZE_WARNING_THRESHOLD = 15 * 1024 * 1024;
export const DIRECT_CONTEXT_TOKEN_LIMIT = 10_000;
const DIRECT_CONTEXT_MEDIA_LIMIT_IMAGES = 5;
export const DIRECT_CONTEXT_MEDIA_LIMITS = { images: DIRECT_CONTEXT_MEDIA_LIMIT_IMAGES };

const isImage = (mimeType: string) => mimeType.startsWith('image/');
const isText = (mimeType: string) => mimeType.startsWith('text/') || mimeType === 'application/json';

export function countFileTokens(files: FileData[]): number {
    const encoding = getEncoding('cl100k_base');
    return files.reduce((t, f) => isText(f.mimeType) ? t + encoding.encode(decodeBase64Content(f.base64)).length : t, 0);
}

export function getMediaCounts(files: FileData[]): { images: number } {
    return { images: files.filter(f => isImage(f.mimeType)).length };
}
const getFileExtension = (fileName: string) => {
    const normalized = fileName.trim().toLowerCase();
    const lastDot = normalized.lastIndexOf('.');
    return lastDot >= 0 ? normalized.slice(lastDot) : '';
};

function getFileConfig(mimeType: string, fileName = ''): FileTypeConfig {
    const configured = FILE_TYPE_CONFIG[mimeType];
    const ext = getFileExtension(fileName);
    if (configured && !(mimeType === 'text/plain' && ext && ext !== '.txt')) return configured;
    if (isImage(mimeType)) return { icon: 'image', color: '#10b981', label: ext.slice(1).toUpperCase() || 'IMAGE' };
    if (isText(mimeType)) return { icon: 'code', color: '#64748b', label: ext.slice(1).toUpperCase() || 'TEXT' };
    return { icon: 'insert_drive_file', color: '#6b7280', label: 'FILE' };
}

function decodeBase64Content(base64: string): string {
    try {
        return new TextDecoder().decode(Uint8Array.from(atob(base64), c => c.charCodeAt(0)));
    } catch {
        return 'Unable to decode file content';
    }
}

function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function processFiles(fileList: FileList | File[]): Promise<FileData[]> {
    return Promise.all(Array.from(fileList).map(file => {
        const name = file.name.trim().toLowerCase();
        const ext = getFileExtension(name);
        const supported = !file.type.startsWith('video/') && !file.type.startsWith('audio/') &&
            !REMOVED_BINARY_MIME_TYPES.has(file.type) && !REMOVED_BINARY_EXTENSIONS.has(ext) &&
            (file.type.startsWith('image/') || file.type.startsWith('text/') || TEXT_EXTENSION_SET.has(ext) || TEXT_FILE_NAMES.has(name));
        if (!supported) return Promise.reject(new Error(`Unsupported file type: ${file.name}`));
        return new Promise<FileData>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = e => {
                const m = String(e.target?.result || '').match(/^data:(.+);base64,(.+)$/);
                if (!m) { reject(new Error('Invalid file format')); return; }
                const mimeType = file.type.startsWith('image/') || file.type.startsWith('text/')
                    ? file.type
                    : (TEXT_EXTENSION_SET.has(ext) ? (TEXT_MIME_BY_EXTENSION[ext] || 'text/plain') : file.type);
                resolve({ mimeType, base64: m[2], name: file.name, size: file.size });
            };
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsDataURL(file);
        });
    }));
}

function getImageCapabilityNotice(): { status: 'supported' | 'unsupported' | 'unverified'; message: string } | null {
    const provider = getProviderForCurrentModel();
    if (provider !== 'local' && provider !== 'openai-compatible') return null;
    const model = getSelectedModel();
    const pm = getRoutingManager().getApiKeyManager().getProviderManager();
    const support = pm.getImageInputSupportForModel(model);
    const label = pm.getProviderDisplayNameForModel(model) || (provider === 'local' ? 'Local model' : 'OpenAI-compatible endpoint');
    if (support === true) return { status: 'supported', message: `${label} confirms ${model} accepts native image input. Tool support and image limits are separate.` };
    if (support === false) return { status: 'unsupported', message: `${label} reports ${model} does not accept image input. The request will likely fail.` };
    return { status: 'unverified', message: `${label} does not expose a reliable vision capability for ${model}. The image will still be sent natively.` };
}

const FilePreviewModal: React.FC<{ file: FileData; onClose: () => void }> = ({ file, onClose }) => {
    const config = getFileConfig(file.mimeType, file.name);
    React.useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', handleKeyDown);
        document.body.style.overflow = 'hidden';
        return () => {
            document.removeEventListener('keydown', handleKeyDown);
            document.body.style.overflow = '';
        };
    }, [onClose]);

    return (
        <div className="file-preview-modal-overlay" onClick={onClose}>
            <div className="file-preview-modal" onClick={e => e.stopPropagation()}>
                <div className="preview-modal-header">
                    <div className="preview-file-info">
                        <Icon name={config.icon} style={{ color: config.color }} />
                        <span className="preview-file-name">{file.name}</span>
                        <span className="preview-file-badge" style={{ backgroundColor: `${config.color}20`, color: config.color }}>{config.label}</span>
                    </div>
                    <button className="preview-close-btn" onClick={onClose} title="Close (Esc)"><Icon name="close" /></button>
                </div>
                <div className="preview-modal-content">
                    {isImage(file.mimeType) && (
                        <div className="preview-image-container">
                            <img src={`data:${file.mimeType};base64,${file.base64}`} alt={file.name} className="preview-image" />
                        </div>
                    )}
                    {isText(file.mimeType) && <pre className="preview-code"><code>{decodeBase64Content(file.base64)}</code></pre>}
                    {!isImage(file.mimeType) && !isText(file.mimeType) && (
                        <div className="preview-unsupported">
                            <Icon name={config.icon} style={{ fontSize: '4rem', color: config.color }} />
                            <p>Preview not available for this file type</p>
                            <a href={`data:${file.mimeType};base64,${file.base64}`} download={file.name} className="preview-download-btn">
                                <Icon name="download" />Download File
                            </a>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export const FileUpload: React.FC = () => {
    const [directFiles, setDirectFiles] = useState<FileData[]>([]);
    const [filesystemFiles, setFilesystemFiles] = useState<FileData[]>([]);
    const [draggingTarget, setDraggingTarget] = useState<'direct' | 'filesystem' | null>(null);
    const [draggedFile, setDraggedFile] = useState<{ source: 'direct' | 'filesystem'; index: number; file: FileData } | null>(null);
    const [previewFile, setPreviewFile] = useState<FileData | null>(null);
    const directInputRef = useRef<HTMLInputElement>(null);
    const filesystemInputRef = useRef<HTMLInputElement>(null);
    const pointerDragStart = useRef<{ source: 'direct' | 'filesystem'; index: number; file: FileData; x: number; y: number } | null>(null);
    const didPointerDrag = useRef(false);
    const dragGhostRef = useRef<HTMLDivElement>(null);
    const dragPosition = useRef({ x: 0, y: 0 });
    const dragTarget = useRef<'direct' | 'filesystem' | null>(null);
    const [, setModelCapabilityRevision] = useState(0);

    const [deepthinkSandboxEnabled, setDeepthinkSandboxEnabled] = useState(false);

    React.useEffect(() => {
        try { setDeepthinkSandboxEnabled(getRoutingManager().getDeepthinkConfigController().isCodeExecutionEnabled()); } catch {}
        const refreshCapability = () => setModelCapabilityRevision(r => r + 1);
        const pm = getRoutingManager().getApiKeyManager().getProviderManager();
        const handleSandboxToggle = () => {
            try { setDeepthinkSandboxEnabled(getRoutingManager().getDeepthinkConfigController().isCodeExecutionEnabled()); } catch {}
        };
        window.addEventListener('selectedModelChanged', refreshCapability);
        pm.addModelUpdateListener(refreshCapability);
        window.addEventListener('sandboxToggled', handleSandboxToggle);
        return () => {
            window.removeEventListener('selectedModelChanged', refreshCapability);
            pm.removeModelUpdateListener(refreshCapability);
            window.removeEventListener('sandboxToggled', handleSandboxToggle);
        };
    }, []);

    React.useLayoutEffect(() => {
        if (draggedFile && dragGhostRef.current) {
            dragGhostRef.current.style.transform = `translate3d(${dragPosition.current.x + 14}px, ${dragPosition.current.y + 14}px, 0)`;
        }
    }, [draggedFile]);

    const syncFiles = useCallback((nextDirect: FileData[], nextFilesystem: FileData[]) => {
        setDirectFiles(nextDirect);
        setFilesystemFiles(nextFilesystem);
        globalState.directContextFiles = nextDirect;
        globalState.filesystemContextFiles = nextFilesystem;
    }, []);

    const handleFiles = useCallback(async (fileList: FileList | File[], target: 'direct' | 'filesystem') => {
        try {
            const newFiles = await processFiles(fileList);
            syncFiles(
                target === 'direct' ? [...directFiles, ...newFiles] : directFiles,
                target === 'filesystem' ? [...filesystemFiles, ...newFiles] : filesystemFiles,
            );
        } catch (error) {
            console.error('Error processing files:', error);
        }
    }, [directFiles, filesystemFiles, syncFiles]);

    const moveFile = useCallback((source: 'direct' | 'filesystem', target: 'direct' | 'filesystem', index: number) => {
        if (source === target) return;
        const file = (source === 'direct' ? directFiles : filesystemFiles)[index];
        if (!file) return;
        syncFiles(
            source === 'direct' ? directFiles.filter((_, i) => i !== index) : [...directFiles, file],
            source === 'filesystem' ? filesystemFiles.filter((_, i) => i !== index) : [...filesystemFiles, file],
        );
    }, [directFiles, filesystemFiles, syncFiles]);

    const sectionAtPoint = (x: number, y: number): 'direct' | 'filesystem' | null => {
        const s = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-upload-section]')?.dataset.uploadSection;
        return s === 'direct' || s === 'filesystem' ? s : null;
    };

    const finishPointerDrag = () => {
        pointerDragStart.current = null;
        dragTarget.current = null;
        setDraggedFile(null);
        setDraggingTarget(null);
        document.body.style.userSelect = '';
    };

    const encoding = getEncoding('cl100k_base');
    const directTokens = directFiles.reduce((t, f) => isText(f.mimeType) ? t + encoding.encode(decodeBase64Content(f.base64)).length : t, 0);
    const directImages = directFiles.filter(f => isImage(f.mimeType)).length;
    const imageCapabilityNotice = directImages > 0 ? getImageCapabilityNotice() : null;
    const directLimitExceeded = directTokens > DIRECT_CONTEXT_TOKEN_LIMIT || directImages > DIRECT_CONTEXT_MEDIA_LIMIT_IMAGES;

    const renderSection = (section: 'direct' | 'filesystem', files: FileData[], inputRef: React.RefObject<HTMLInputElement | null>) => {
        const isDirect = section === 'direct';
        const totalSize = files.reduce((sum, f) => sum + f.size, 0);
        const sizeWarning = totalSize > SIZE_WARNING_THRESHOLD;
        return (
            <section className={`upload-context-section ${isDirect ? 'direct-context-section' : 'filesystem-context-section'} ${draggingTarget === section ? 'is-file-drag-target' : ''}`} data-upload-section={section}>
                <div className="upload-context-heading"><div><h4>{isDirect ? 'Direct context' : 'Context through file-system'}</h4></div></div>
                <div
                    className={`file-drop-zone ${!isDirect ? 'compact-upload-control' : ''} ${draggingTarget === section ? 'dragging' : ''} ${files.length > 0 ? 'has-files' : ''}`}
                    onDragOver={e => { e.preventDefault(); e.stopPropagation(); dragTarget.current = section; setDraggingTarget(p => p === section ? p : section); }}
                    onDragLeave={e => { e.preventDefault(); e.stopPropagation(); if (!e.currentTarget.contains(e.relatedTarget as Node)) { dragTarget.current = null; setDraggingTarget(null); } }}
                    onDrop={e => {
                        e.preventDefault();
                        e.stopPropagation();
                        setDraggingTarget(null);
                        setDraggedFile(null);
                        if (e.dataTransfer.files?.length > 0) { handleFiles(e.dataTransfer.files, section); return; }
                        const source = e.dataTransfer.getData('application/x-iterative-studio-upload');
                        const idx = Number(e.dataTransfer.getData('text/plain'));
                        if ((source === 'direct' || source === 'filesystem') && Number.isInteger(idx)) moveFile(source, section, idx);
                    }}
                    onClick={() => inputRef.current?.click()}
                >
                    <input type="file" ref={inputRef} onChange={e => { if (e.target.files) handleFiles(e.target.files, section); if (inputRef.current) inputRef.current.value = ''; }} accept={ACCEPTED_FILES} multiple style={{ display: 'none' }} />
                    {isDirect && files.length === 0 ? (
                        <div className="drop-zone-content">
                            <Icon name="file-up" className="drop-icon" />
                            <div className="drop-text">
                                <span className="drop-primary">Drop files here or click to upload</span>
                                <span className="drop-secondary">Images, text, Markdown, data, and source code</span>
                            </div>
                        </div>
                    ) : (
                        <div className="drop-zone-mini"><Icon name="add" /><span>Add more files</span></div>
                    )}
                </div>
                {isDirect && <div className={`context-limit-status ${directLimitExceeded ? 'limit-exceeded' : ''}`}><span>{directTokens.toLocaleString()} / {DIRECT_CONTEXT_TOKEN_LIMIT.toLocaleString()} text tokens</span><span>{directImages}/{DIRECT_CONTEXT_MEDIA_LIMIT_IMAGES} images</span></div>}
                {isDirect && imageCapabilityNotice && <div className={`image-capability-indicator ${imageCapabilityNotice.status}`} role={imageCapabilityNotice.status === 'unsupported' ? 'alert' : 'status'}><Icon name={imageCapabilityNotice.status === 'supported' ? 'check_circle' : 'info'} /><span>{imageCapabilityNotice.message}</span></div>}
                {files.length > 0 && (
                    <div className="file-list-container scrollbar-compact">
                        <div className="file-list-header">
                            <span className="file-count">{files.length} file{files.length !== 1 ? 's' : ''} • {formatFileSize(totalSize)}</span>
                            <button className="clear-all-btn" onClick={() => syncFiles(isDirect ? [] : directFiles, isDirect ? filesystemFiles : [])}><Icon name="delete_sweep" />Clear all</button>
                        </div>
                        {sizeWarning && <div className="size-warning"><Icon name="warning" /><span>Large upload ({formatFileSize(totalSize)}). Some providers may reject requests over 20MB.</span></div>}
                        <div className="file-grid">
                            {files.map((file, idx) => {
                                const config = getFileConfig(file.mimeType, file.name);
                                const isDraggingThisFile = draggedFile?.source === section && draggedFile.index === idx;
                                return (
                                    <div
                                        key={`${section}-${idx}-${file.name}`}
                                        className={`file-card ${isDraggingThisFile ? 'is-dragging' : ''}`}
                                        aria-label={file.name}
                                        onPointerDown={e => {
                                            if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
                                            didPointerDrag.current = false;
                                            pointerDragStart.current = { source: section, index: idx, file, x: e.clientX, y: e.clientY };
                                        }}
                                        onPointerMove={e => {
                                            const start = pointerDragStart.current;
                                            if (!start) return;
                                            if (!didPointerDrag.current && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 7) return;
                                            if (!didPointerDrag.current) {
                                                e.currentTarget.setPointerCapture(e.pointerId);
                                                didPointerDrag.current = true;
                                                document.body.style.userSelect = 'none';
                                            }
                                            const t = sectionAtPoint(e.clientX, e.clientY);
                                            const nextTarget = t && t !== start.source ? t : null;
                                            if (dragTarget.current !== nextTarget) { dragTarget.current = nextTarget; setDraggingTarget(nextTarget); }
                                            dragPosition.current = { x: e.clientX, y: e.clientY };
                                            if (dragGhostRef.current) dragGhostRef.current.style.transform = `translate3d(${e.clientX + 14}px, ${e.clientY + 14}px, 0)`;
                                            if (!draggedFile) setDraggedFile({ source: start.source, index: start.index, file: start.file });
                                        }}
                                        onPointerUp={e => {
                                            const start = pointerDragStart.current;
                                            const t = sectionAtPoint(e.clientX, e.clientY);
                                            if (start && didPointerDrag.current && t) moveFile(start.source, t, start.index);
                                            if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
                                            finishPointerDrag();
                                        }}
                                        onPointerCancel={finishPointerDrag}
                                        onClick={() => { if (!didPointerDrag.current) setPreviewFile(file); }}
                                    >
                                        <button className="file-remove-btn" onClick={e => { e.stopPropagation(); syncFiles(isDirect ? directFiles.filter((_, i) => i !== idx) : directFiles, !isDirect ? filesystemFiles.filter((_, i) => i !== idx) : filesystemFiles); }} title="Remove file"><Icon name="close" /></button>
                                        <div className="file-preview-thumb">{isImage(file.mimeType) ? <img src={`data:${file.mimeType};base64,${file.base64}`} alt={file.name} className="file-image" /> : <div className="file-icon-wrapper" style={{ backgroundColor: `${config.color}15` }}><Icon name={config.icon} className="file-type-icon" style={{ color: config.color }} /></div>}</div>
                                        <div className="file-info"><span className="file-name">{file.name}</span><div className="file-meta"><span className="file-type-badge" style={{ backgroundColor: `${config.color}20`, color: config.color }}>{config.label}</span><span className="file-size">{formatFileSize(file.size)}</span></div></div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}
            </section>
        );
    };

    const showFilesystemSection = deepthinkSandboxEnabled;

    return (
        <>
            <div className="file-upload-wrapper">
                {renderSection('direct', directFiles, directInputRef)}
                {showFilesystemSection && renderSection('filesystem', filesystemFiles, filesystemInputRef)}
            </div>
            {draggedFile && createPortal(
                <div ref={dragGhostRef} className="file-drag-ghost">
                    <Icon name={getFileConfig(draggedFile.file.mimeType, draggedFile.file.name).icon} />
                    <span>{draggedFile.file.name}</span>
                </div>,
                document.body
            )}
            {previewFile && createPortal(<FilePreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />, document.body)}
        </>
    );
};
