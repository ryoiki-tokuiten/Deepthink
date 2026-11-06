import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LucideIcon } from 'lucide-react';
import {
    ArrowLeft,
    ArrowLeftRight,
    ArrowRight,
    BadgeCheck,
    Ban,
    Bot,
    Brain,
    BrainCircuit,
    Braces,
    Calendar,
    ChartLine,
    ChartNoAxesCombined,
    Check,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    ChevronUp,
    CircleAlert,
    CircleCheck,
    CirclePlay,
    CircleStop,
    Clock3,
    CloudUpload,
    Code,
    Columns2,
    Copy,
    Database,
    Diff,
    Download,
    ExternalLink,
    FileImage,
    FileText,
    FileUp,
    Film,
    Fingerprint,
    Flag,
    FlaskConical,
    GitCompare,
    GitMerge,
    History,
    Hourglass,
    Image,
    Info,
    Key,
    KeyRound,
    Layers3,
    Lightbulb,
    Link,
    ListVideo,
    LoaderCircle,
    Maximize,
    MessageSquare,
    Minimize,
    Minimize2,
    Monitor,
    Moon,
    PanelLeftClose,
    PanelLeftOpen,
    Paperclip,
    Pause,
    Pencil,
    Play,
    Plus,
    RotateCcw,
    Rows3,
    ScanSearch,
    Search,
    SearchCode,
    Settings2,
    Shield,
    ShieldCheck,
    SkipBack,
    SkipForward,
    Sparkles,
    SquareTerminal,
    Sun,
    Table2,
    Tag,
    Trash2,
    TriangleAlert,
    Upload,
    User,
    Workflow,
    Wrench,
    X,
    Eye,
    EyeOff,
    Folder,
    File,
    Terminal,
    RefreshCw,
} from 'lucide-react';

type IconAttributes = Record<string, string | number | boolean | null | undefined>;

interface IconProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
    name: string;
    size?: number | string;
    strokeWidth?: number;
    absoluteStrokeWidth?: boolean;
}

const ICON_COMPONENTS: Record<string, LucideIcon> = {
    account_tree: Workflow,
    add: Plus,
    api: Braces,
    article: FileText,
    arrow_back: ArrowLeft,
    arrow_forward: ArrowRight,
    auto_awesome_motion: Sparkles,
    build: Wrench,
    block: Ban,
    chevron_left: ChevronLeft,
    chevron_right: ChevronRight,
    'chart-no-axes-combined': ChartNoAxesCombined,
    chart_no_axes_combined: ChartNoAxesCombined,
    close: X,
    cloud_upload: CloudUpload,
    code: Code,
    compare: GitCompare,
    compare_arrows: ArrowLeftRight,
    compress: Minimize2,
    content_copy: Copy,
    data_object: Braces,
    dark_mode: Moon,
    delete_sweep: Trash2,
    deployed_code: SquareTerminal,
    difference: Diff,
    dock_to_left: PanelLeftOpen,
    dock_to_right: PanelLeftClose,
    download: Download,
    edit: Pencil,
    'file-up': FileUp,
    file_up: FileUp,
    FileUp: FileUp,
    fingerprint: Fingerprint,
    gif: FileImage,
    hourglass_empty: Hourglass,
    integration_instructions: GitMerge,
    javascript: Code,
    keyboard_arrow_down: ChevronDown,
    keyboard_arrow_up: ChevronUp,
    dynamic_form: ListVideo,
    rocket_launch: CirclePlay,
    help: Info,
    fullscreen: Maximize,
    fullscreen_exit: Minimize,
    history: History,
    image: Image,
    info: Info,
    key: Key,
    key_round: KeyRound,
    light_mode: Sun,
    lightbulb: Lightbulb,
    link: Link,
    manage_search: SearchCode,
    movie: Film,
    paperclip: Paperclip,
    'paper-clip': Paperclip,
    Paperclip: Paperclip,
    attach_file: Paperclip,
    pending: Clock3,
    pause: Pause,
    play_arrow: Play,
    play_circle: CirclePlay,
    preview: Monitor,
    progress_activity: LoaderCircle,
    psychology: Brain,
    psychology_alt: BrainCircuit,
    rate_review: MessageSquare,
    restart_alt: RotateCcw,
    security: Shield,
    skip_next: SkipForward,
    skip_previous: SkipBack,
    stop_circle: CircleStop,
    subscriptions: ListVideo,
    table_chart: Table2,
    timeline: ChartLine,
    upload: Upload,
    verified: BadgeCheck,
    view_agenda: Rows3,
    view_column: Columns2,
    visibility: Eye,
    visibility_off: EyeOff,
    warning: TriangleAlert,
    workspaces: Layers3,
    database: Database,
    science: FlaskConical,
    troubleshoot: ScanSearch,
    flag: Flag,
    settings: Settings2,
    smart_toy: Bot,
    check: Check,
    check_circle: CircleCheck,
    CircleCheck: CircleCheck,
    circle_alert: CircleAlert,
    'circle-alert': CircleAlert,
    CircleAlert: CircleAlert,
    Search: Search,
    description: FileText,
    event: Calendar,
    label: Tag,
    open_in_new: ExternalLink,
    person: User,
    picture_as_pdf: FileText,
    verified_user: ShieldCheck,
    folder: Folder,
    file: File,
    terminal: Terminal,
    refresh: RefreshCw,
    chevron_down: ChevronDown,
};

const ICON_ALIASES: Record<string, string> = {
    auto_awesome: 'auto_awesome_motion',
    auto_fix_high: 'auto_awesome_motion',
    auto_fix_off: 'block',
    auto_fix: 'build',
    expand_less: 'keyboard_arrow_up',
    expand_more: 'keyboard_arrow_down',
    insert_drive_file: 'description',
    settings_suggest: 'settings',
};

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function serializeAttributes(attributes: IconAttributes): string {
    const pairs: string[] = [];

    Object.entries(attributes).forEach(([key, value]) => {
        if (value === false || value === null || value === undefined) {
            return;
        }

        if (value === true) {
            pairs.push(` ${key}`);
            return;
        }

        pairs.push(` ${key}="${escapeHtml(String(value))}"`);
    });

    return pairs.join('');
}

function getIconComponent(name: string): LucideIcon {
    return ICON_COMPONENTS[resolveIconName(name)] ?? Info;
}

function renderSvgMarkup(name: string, size: number | string = '1em', strokeWidth = 2, absoluteStrokeWidth = false): string {
    const IconComponent = getIconComponent(name);

    return renderToStaticMarkup(
        <IconComponent
            aria-hidden="true"
            absoluteStrokeWidth={absoluteStrokeWidth}
            className="app-icon"
            focusable="false"
            size={size}
            strokeWidth={strokeWidth}
        />
    );
}

function resolveIconName(name: string): string {
    const trimmed = name.trim();
    return ICON_COMPONENTS[trimmed] ? trimmed : (ICON_ALIASES[trimmed] || trimmed);
}

export function renderIconMarkup(
    name: string,
    className = '',
    attributes: IconAttributes = {},
    size: number | string = '1em',
    strokeWidth = 2,
    absoluteStrokeWidth = false
): string {
    const resolved = resolveIconName(name);
    const wrapperClassName = ['icon-slot', className].filter(Boolean).join(' ');

    return `<span${serializeAttributes({
        class: wrapperClassName,
        'data-icon-name': resolved,
        ...attributes,
    })}>${renderSvgMarkup(resolved, size, strokeWidth, absoluteStrokeWidth)}</span>`;
}

export function setIconSlot(
    element: Element | null,
    name: string,
    size: number | string = '1em',
    strokeWidth = 2,
    absoluteStrokeWidth = false
): HTMLElement | null {
    if (!(element instanceof HTMLElement)) {
        return null;
    }

    const resolved = resolveIconName(name);
    element.dataset.iconName = resolved;
    element.innerHTML = renderSvgMarkup(resolved, size, strokeWidth, absoluteStrokeWidth);

    return element;
}

export const Icon: React.FC<IconProps> = ({
    absoluteStrokeWidth = false,
    className = '',
    name,
    size = '1em',
    strokeWidth = 2,
    ...rest
}) => {
    const resolved = resolveIconName(name);
    const IconComponent = getIconComponent(resolved);

    return (
        <span
            {...rest}
            className={['icon-slot', className].filter(Boolean).join(' ')}
            data-icon-name={resolved}
        >
            <IconComponent
                aria-hidden="true"
                absoluteStrokeWidth={absoluteStrokeWidth}
                className="app-icon"
                focusable="false"
                size={size}
                strokeWidth={strokeWidth}
            />
        </span>
    );
};
