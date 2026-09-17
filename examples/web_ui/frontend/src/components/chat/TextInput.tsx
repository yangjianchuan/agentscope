import type { ContentBlock, TextBlock } from '@agentscope-ai/agentscope/message';
import {
	BookText,
	Check,
	File,
	Folder,
	Paperclip,
	Loader2,
	Plus,
	Square,
	type LucideIcon,
	XIcon,
	FileText,
	ArrowUp,
} from 'lucide-react';
import mime from 'mime';
import React, {
	useState,
	useRef,
	useMemo,
	useEffect,
	useLayoutEffect,
	type KeyboardEvent,
	useImperativeHandle,
	forwardRef,
} from 'react';

import { Button } from '../ui/button';
import { Kbd } from '../ui/kbd';
import { workspaceApi, type DirectoryEntry, type SkillView } from '@/api';
import {
	Attachment,
	AttachmentAction,
	AttachmentActions,
	AttachmentContent,
	AttachmentDescription,
	AttachmentGroup,
	AttachmentMedia,
	AttachmentTitle,
} from '@/components/ui/attachment.tsx';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ReplyPhase } from '@/hooks/useMessages';
import { useTranslation } from '@/i18n/useI18n.ts';
import { cn } from '@/lib/utils';

/**
 * Represents a file that has been selected and processed (or is being processed).
 */
interface ProcessedFile {
	/** Original file name for display */
	name: string;
	/** Processing status */
	status: 'processing' | 'done';
	/** The resulting ContentBlock after processing (available when status === 'done') */
	block: ContentBlock | null;
}

interface TextInputProps {
	onSend: (blocks: ContentBlock[]) => void;
	placeholder?: string;
	autoComplete?: (input: string) => string | null;
	disabled?: boolean;
	className?: string;
	/**
	 * Controls which file types the file picker accepts.
	 * Uses standard MIME types and file extensions, e.g.:
	 *   - Images:    "image/*" or "image/jpeg", "image/png"
	 *   - Audio:     "audio/*" or "audio/mpeg", "audio/wav"
	 *   - Video:     "video/*"
	 *   - Plain text:"text/plain"
	 *   - PDF:       "application/pdf"
	 *   - Word:      ".doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	 *   - Excel:     ".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	 *
	 * When undefined → no restriction (all files allowed).
	 * When empty array [] → attachment button is disabled (model accepts no files).
	 */
	allowedInputTypes?: string[];
	/**
	 * Called immediately when a file is selected (at attach time, NOT at send time).
	 * Should resolve to a ContentBlock to include in the message, or null to skip the file.
	 * Runs concurrently for all selected files; the UI shows a loading state per file while processing.
	 */
	fileProcessor: (file: File) => Promise<ContentBlock | null>;
	/**
	 * The current reply lifecycle phase from ``useMessages``. Drives the
	 * send / stop button in one shot:
	 *   - ``idle`` — Send (enabled when there is content to send)
	 *   - ``streaming`` — Stop (click to interrupt)
	 *   - ``interrupting`` — Stop (disabled while the interrupt is in flight)
	 */
	phase?: ReplyPhase;
	onInterrupt?: () => void;
	/** Skills in the user's installed library, shown by the slash menu. */
	installedSkills?: SkillView[];
	/** Whether the installed-skill library is still loading. */
	installedSkillsLoading?: boolean;
	/** Skill names already equipped in this session's workspace. */
	workspaceSkillNames?: ReadonlySet<string>;
	/** Equips installed skills that are selected from the slash menu. */
	onAddSkillsFromLibrary?: (skillIds: string[]) => Promise<void>;
	/** Agent owning the workspace whose files may be referenced with `@`. */
	agentId?: string | null;
	/** Session owning the workspace whose files may be referenced with `@`. */
	sessionId?: string | null;
	/** Directory used as the root of `@` file references. */
	workingDirectory?: string | null;
	/**
	 * Content rendered directly above the input pill, inside the outer
	 * wrapper that {@link className} styles (e.g. the working directory
	 * and git status).
	 *
	 * The pill keeps all four of its corners, so the two only read as one
	 * surface if the caller gives that wrapper a background and a radius
	 * concentric with the pill's — outer radius = 28px + the wrapper's
	 * padding. Anything less and the pill's top corners cut into the
	 * header's edges.
	 */
	headerSlot?: React.ReactNode;
}

export interface TextInputRef {
	focus: () => void;
}

/** One line box of textarea text: ``text-sm`` (14px) at a 1.5 line-height. */
const LINE_HEIGHT_PX = 21;
/** Height of the input in its collapsed, single-line state. */
const COLLAPSED_HEIGHT_PX = 52;
/**
 * Padding rather than height: a textarea top-aligns its text, so forcing the
 * height would leave dead space under the caret instead of centring the line.
 */
const TEXTAREA_PADDING_Y_PX = (COLLAPSED_HEIGHT_PX - LINE_HEIGHT_PX) / 2;
/** Growth stops after six lines of text; the textarea scrolls beyond that. */
const MAX_HEIGHT_PX = LINE_HEIGHT_PX * 6 + TEXTAREA_PADDING_Y_PX * 2;
/** Horizontal padding of the textarea, mirrored by the overlay and the ghost. */
const TEXTAREA_PADDING_X_PX = 12;
const SKILL_MENU_ID = 'chat-skill-command-menu';
const FILE_MENU_ID = 'chat-file-mention-menu';

interface ActiveFileMention {
	start: number;
	end: number;
	query: string;
}

/**
 * Find an unfinished `@` file reference immediately before the caret.
 * Quoted references keep paths containing spaces editable until the closing
 * quote is inserted after selection.
 */
function activeFileMention(value: string, cursor: number): ActiveFileMention | null {
	const beforeCursor = value.slice(0, cursor);
	const quoted = beforeCursor.match(/(?:^|\s)@"([^"]*)$/);
	if (quoted) {
		return {
			start: cursor - quoted[1].length - 2,
			end: cursor,
			query: quoted[1],
		};
	}

	const plain = beforeCursor.match(/(?:^|\s)@([^\s"]*)$/);
	if (!plain) return null;
	return {
		start: cursor - plain[1].length - 1,
		end: cursor,
		query: plain[1],
	};
}

/** Split a mention query into the directory to list and basename to filter. */
function splitFileQuery(query: string): { directory: string; search: string } | null {
	const normalized = query.replace(/\\/g, '/');
	if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return null;
	const lastSlash = normalized.lastIndexOf('/');
	const directory = lastSlash === -1 ? '' : normalized.slice(0, lastSlash);
	const segments = directory.split('/').filter(Boolean);
	if (segments.some((segment) => segment === '.' || segment === '..')) return null;
	return {
		directory: segments.join('/'),
		search: lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1),
	};
}

function joinRelativePath(directory: string, name: string): string {
	return directory ? `${directory}/${name}` : name;
}

function formatFileSize(size: number | null): string {
	if (size === null) return '';
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Return the search part of a skill slash selector, or ``null`` when the
 * current value is an ordinary message. Both `/query` and `/skill query`
 * are accepted while the canonical value inserted after selection is the
 * latter.
 */
function skillSlashQuery(value: string): string | null {
	const command = value.match(/^\/skill(?:\s+([^\s]*))?$/i);
	if (command) return command[1] ?? '';
	const shortcut = value.match(/^\/([^\s]*)$/);
	return shortcut?.[1] ?? null;
}

/**
 * A text input component with file attachment support and autocomplete functionality.
 *
 * @param root0 - The component props.
 * @param root0.onSend - Callback function to handle sending content blocks.
 * @param root0.placeholder - Placeholder text for the input field.
 * @param root0.autoComplete - Function to provide autocomplete suggestions.
 * @param root0.disabled - Whether the input is disabled.
 * @param root0.className - Additional CSS classes for styling.
 * @returns A TextInput component.
 */
export const TextInput = forwardRef<TextInputRef, TextInputProps>(
	(
		{
			onSend,
			placeholder,
			autoComplete,
			disabled = false,
			className,
			allowedInputTypes,
			fileProcessor,
			phase = 'idle',
			onInterrupt,
			installedSkills = [],
			installedSkillsLoading = false,
			workspaceSkillNames = new Set<string>(),
			onAddSkillsFromLibrary,
			agentId = null,
			sessionId = null,
			workingDirectory = null,
			headerSlot,
		},
		ref,
	) => {
		const { t } = useTranslation();
		const defaultPlaceholder = placeholder || t('chat.inputPlaceholder');
		const [value, setValue] = useState('');
		const [files, setFiles] = useState<ProcessedFile[]>([]);
		const [isFocused, setIsFocused] = useState(false);
		const [skillMenuOpen, setSkillMenuOpen] = useState(false);
		const [skillMenuForced, setSkillMenuForced] = useState(false);
		const [activeSkillIndex, setActiveSkillIndex] = useState(0);
		const [addingSkillId, setAddingSkillId] = useState<string | null>(null);
		const [skillError, setSkillError] = useState<string | null>(null);
		const [cursorPosition, setCursorPosition] = useState(0);
		const [fileRootPath, setFileRootPath] = useState<string | null>(null);
		const [fileListingDirectory, setFileListingDirectory] = useState<string | null>(null);
		const [fileEntries, setFileEntries] = useState<DirectoryEntry[]>([]);
		const [fileMenuLoading, setFileMenuLoading] = useState(false);
		const [fileMenuError, setFileMenuError] = useState<string | null>(null);
		const [activeFileIndex, setActiveFileIndex] = useState(0);
		const [dismissedFileMention, setDismissedFileMention] = useState<string | null>(null);
		const textareaRef = useRef<HTMLTextAreaElement>(null);
		const fileInputRef = useRef<HTMLInputElement>(null);
		const measureRef = useRef<HTMLSpanElement>(null);
		const fileRequestId = useRef(0);
		/** ``true`` — textarea takes the full width, buttons drop to their own row. */
		const [isStacked, setIsStacked] = useState(false);

		// Derive the accept attribute for the hidden file input
		const acceptAttr =
			allowedInputTypes && allowedInputTypes.length > 0
				? allowedInputTypes.join(',')
				: undefined;

		// Attachment button is disabled when the model explicitly accepts no file types
		const attachDisabled =
			disabled || (allowedInputTypes !== undefined && allowedInputTypes.length === 0);

		// Whether any file is still being processed (block send until all done)
		const hasProcessing = files.some((f) => f.status === 'processing');

		useImperativeHandle(ref, () => ({
			focus: () => textareaRef.current?.focus(),
		}));

		// Grow the textarea with its content. The ``auto`` reset is what lets it
		// shrink again — ``scrollHeight`` never reports less than the current height.
		useLayoutEffect(() => {
			const textarea = textareaRef.current;
			if (!textarea) return;
			textarea.style.height = 'auto';
			textarea.style.height = `${textarea.scrollHeight}px`;
			// Stacking widens the textarea, so the line count has to be redone.
		}, [value, isStacked]);

		// Measured on the ghost, not the textarea: stacking widens the textarea, so
		// measuring it would flip-flop (wraps → stack → fits → unstack → wraps).
		useLayoutEffect(() => {
			const ghost = measureRef.current;
			if (!ghost) return;
			setIsStacked(ghost.scrollHeight > LINE_HEIGHT_PX);
		}, [value]);

		// Calculate autocomplete suggestion using useMemo
		const suggestion = useMemo(() => {
			if (autoComplete && value && isFocused) {
				const result = autoComplete(value);
				// Only return the part after the cursor
				if (result && result.startsWith(value)) {
					return result.substring(value.length);
				}
				return result || '';
			}
			return '';
		}, [value, autoComplete, isFocused]);

		const slashQuery = skillMenuForced ? '' : skillSlashQuery(value);
		const fileMention = useMemo(
			() => activeFileMention(value, cursorPosition),
			[value, cursorPosition],
		);
		const fileQuery = useMemo(
			() => (fileMention ? splitFileQuery(fileMention.query) : null),
			[fileMention],
		);
		const fileMentionKey = fileMention
			? `${fileMention.start}:${fileMention.end}:${fileMention.query}`
			: null;
		const showFileMenu = Boolean(
			isFocused &&
			fileMention &&
			fileQuery &&
			agentId &&
			sessionId &&
			phase === 'idle' &&
			!disabled &&
			fileMentionKey !== dismissedFileMention,
		);

		useEffect(() => {
			setFileRootPath(null);
			setFileListingDirectory(null);
			setFileEntries([]);
			setFileMenuError(null);
			fileRequestId.current += 1;
		}, [agentId, sessionId, workingDirectory]);

		useEffect(() => {
			if (!showFileMenu || !agentId || !sessionId || !fileQuery) return;
			if (fileRootPath && fileListingDirectory === fileQuery.directory) return;

			const requestId = ++fileRequestId.current;
			let cancelled = false;
			setFileMenuLoading(true);
			setFileMenuError(null);

			void (async () => {
				try {
					let rootPath = fileRootPath;
					if (!rootPath) {
						const root = await workspaceApi.directories(
							agentId,
							sessionId,
							workingDirectory ?? '',
						);
						if (cancelled || requestId !== fileRequestId.current) return;
						rootPath = root.path;
						setFileRootPath(root.path);
						if (!fileQuery.directory) {
							setFileEntries(root.entries);
							setFileListingDirectory('');
							return;
						}
					}

					const listing = await workspaceApi.directories(
						agentId,
						sessionId,
						`${rootPath}/${fileQuery.directory}`,
					);
					if (cancelled || requestId !== fileRequestId.current) return;
					setFileEntries(listing.entries);
					setFileListingDirectory(fileQuery.directory);
				} catch {
					if (cancelled || requestId !== fileRequestId.current) return;
					setFileEntries([]);
					setFileListingDirectory(fileQuery.directory);
					setFileMenuError(t('textInput.fileMenuError'));
				} finally {
					if (!cancelled && requestId === fileRequestId.current) {
						setFileMenuLoading(false);
					}
				}
			})();

			return () => {
				cancelled = true;
			};
		}, [
			showFileMenu,
			agentId,
			sessionId,
			workingDirectory,
			fileRootPath,
			fileListingDirectory,
			fileQuery,
			t,
		]);

		const matchingFiles = useMemo(() => {
			const search = fileQuery?.search.trim().toLocaleLowerCase() ?? '';
			return fileEntries
				.filter((entry) => !search || entry.name.toLocaleLowerCase().includes(search))
				.sort((left, right) => {
					if (left.is_dir !== right.is_dir) return left.is_dir ? -1 : 1;
					return left.name.localeCompare(right.name);
				})
				.slice(0, 100);
		}, [fileEntries, fileQuery?.search]);

		useEffect(() => {
			setActiveFileIndex(0);
		}, [fileQuery?.directory, fileQuery?.search]);

		useEffect(() => {
			if (activeFileIndex < matchingFiles.length) return;
			setActiveFileIndex(Math.max(0, matchingFiles.length - 1));
		}, [activeFileIndex, matchingFiles.length]);

		const matchingSkills = useMemo(() => {
			const query = (slashQuery ?? '').trim().toLocaleLowerCase();
			return installedSkills
				.filter((skill) => skill.enabled)
				.filter((skill) => {
					if (!query) return true;
					return [
						skill.name,
						skill.display_name ?? '',
						skill.description,
						...skill.tags,
					].some((part) => part.toLocaleLowerCase().includes(query));
				});
		}, [installedSkills, slashQuery]);
		const showSkillMenu =
			isFocused &&
			skillMenuOpen &&
			slashQuery !== null &&
			phase === 'idle' &&
			!disabled &&
			!showFileMenu;

		useEffect(() => {
			setActiveSkillIndex(0);
		}, [slashQuery]);

		useEffect(() => {
			if (activeSkillIndex < matchingSkills.length) return;
			setActiveSkillIndex(Math.max(0, matchingSkills.length - 1));
		}, [activeSkillIndex, matchingSkills.length]);

		const handleSkillSelect = async (skill: SkillView) => {
			if (addingSkillId) return;
			setSkillError(null);
			try {
				if (!workspaceSkillNames.has(skill.name)) {
					if (!onAddSkillsFromLibrary) return;
					setAddingSkillId(skill.id);
					await onAddSkillsFromLibrary([skill.id]);
				}

				const selectorOnly = skillSlashQuery(value) !== null;
				const message = selectorOnly ? '' : value.trimStart();
				setValue(`/skill ${skill.name} ${message}`);
				setSkillMenuOpen(false);
				setSkillMenuForced(false);
				requestAnimationFrame(() => textareaRef.current?.focus());
			} catch (error) {
				setSkillError((error as Error).message);
			} finally {
				setAddingSkillId(null);
			}
		};

		const replaceFileMention = (replacement: string, appendSpace: boolean) => {
			if (!fileMention) return;
			const suffix = value.slice(fileMention.end);
			const separator = appendSpace && !/^\s/.test(suffix) ? ' ' : '';
			const nextValue = value.slice(0, fileMention.start) + replacement + separator + suffix;
			const nextCursor = fileMention.start + replacement.length + separator.length;
			setValue(nextValue);
			setCursorPosition(nextCursor);
			setDismissedFileMention(null);
			requestAnimationFrame(() => {
				textareaRef.current?.focus();
				textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
			});
		};

		const handleFileMentionSelect = (entry: DirectoryEntry) => {
			if (!fileQuery) return;
			const relativePath = joinRelativePath(fileQuery.directory, entry.name);
			if (entry.is_dir) {
				const replacement = /\s/.test(relativePath)
					? `@"${relativePath}/`
					: `@${relativePath}/`;
				replaceFileMention(replacement, false);
				return;
			}

			const replacement = /\s/.test(relativePath) ? `@"${relativePath}"` : `@${relativePath}`;
			replaceFileMention(replacement, true);
		};

		const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.nativeEvent.isComposing) return;

			if (showFileMenu) {
				if (e.key === 'Escape') {
					e.preventDefault();
					setDismissedFileMention(fileMentionKey);
					return;
				}
				if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
					e.preventDefault();
					if (matchingFiles.length === 0) return;
					const direction = e.key === 'ArrowDown' ? 1 : -1;
					setActiveFileIndex(
						(index) =>
							(index + direction + matchingFiles.length) % matchingFiles.length,
					);
					return;
				}
				if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
					e.preventDefault();
					const selected = matchingFiles[activeFileIndex];
					if (selected) handleFileMentionSelect(selected);
					return;
				}
			}

			if (showSkillMenu) {
				if (e.key === 'Escape') {
					e.preventDefault();
					setSkillMenuOpen(false);
					setSkillMenuForced(false);
					return;
				}
				if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
					e.preventDefault();
					if (matchingSkills.length === 0) return;
					const direction = e.key === 'ArrowDown' ? 1 : -1;
					setActiveSkillIndex(
						(index) =>
							(index + direction + matchingSkills.length) % matchingSkills.length,
					);
					return;
				}
				if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
					e.preventDefault();
					const selected = matchingSkills[activeSkillIndex];
					if (selected) void handleSkillSelect(selected);
					return;
				}
			}

			// Tab key to select autocomplete
			if (e.key === 'Tab' && suggestion) {
				e.preventDefault();
				setValue(value + suggestion);
				return;
			}

			// Enter to send message, Shift+Enter for new line
			if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
				e.preventDefault();
				handleSend();
			}
		};

		const handleSend = () => {
			// ``phase`` is guarded here rather than only on the button, since Enter
			// calls this directly and would otherwise send during a running reply.
			if (phase !== 'idle' || !value.trim() || disabled || hasProcessing) return;

			const blocks: ContentBlock[] = [];

			// Add text block
			if (value.trim()) {
				const textBlock: TextBlock = {
					id: crypto.randomUUID(),
					type: 'text',
					text: value.trim(),
					created_at: new Date().toISOString(),
					finished_at: new Date().toISOString(),
				};
				blocks.push(textBlock);
			}

			// Add processed file blocks (skip errored ones)
			files.forEach((f) => {
				if (f.status === 'done' && f.block) {
					blocks.push(f.block);
				}
			});

			onSend?.(blocks);
			setValue('');
			setCursorPosition(0);
			setDismissedFileMention(null);
			setFiles([]);
		};

		/**
		 * Send / stop button configuration derived from the current reply
		 * phase. One struct = one branch of rendering, so the JSX stays flat.
		 */
		const sendButton: {
			icon: LucideIcon;
			tooltip: string;
			disabled: boolean;
			onClick: (() => void) | undefined;
		} = (() => {
			if (phase === 'streaming') {
				return {
					icon: Square,
					tooltip: t('textInput.stop'),
					disabled: false,
					onClick: onInterrupt,
				};
			}
			if (phase === 'interrupting') {
				return {
					icon: Square,
					tooltip: t('textInput.stopping'),
					disabled: true,
					onClick: onInterrupt,
				};
			}
			return {
				icon: ArrowUp,
				tooltip: t('textInput.send'),
				disabled: disabled || !value.trim() || hasProcessing,
				onClick: handleSend,
			};
		})();

		const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
			if (!e.target.files) return;
			const selected = Array.from(e.target.files);
			// Reset input value so the same file can be re-selected
			e.target.value = '';

			selected.forEach((file) => {
				// Insert a placeholder in processing state
				const placeholder: ProcessedFile = {
					name: file.name,
					status: 'processing',
					block: null,
				};

				setFiles((prev) => [...prev, placeholder]);

				fileProcessor(file)
					.then((block) => {
						setFiles(
							(prev) =>
								prev
									.map((f) =>
										f.name === file.name && f.status === 'processing'
											? block
												? { ...f, status: 'done', block }
												: null
											: f,
									)
									.filter(Boolean) as ProcessedFile[],
						);
					})
					.catch(() => {
						// Caller is responsible for error notification (e.g. toast).
						// Just silently remove the entry here.
						setFiles((prev) =>
							prev.filter(
								(f) => !(f.name === file.name && f.status === 'processing'),
							),
						);
					});
			});
		};

		return (
			<div className={cn('relative flex flex-col', className)}>
				{showFileMenu && (
					<div
						id={FILE_MENU_ID}
						role="listbox"
						aria-label={t('textInput.fileMenuTitle')}
						className="absolute inset-x-1 bottom-full z-[60] mb-2 overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-lg"
					>
						<div className="flex h-10 items-center gap-2 border-b px-3 text-sm font-medium">
							<File className="size-4 text-muted-foreground" />
							<span>{t('textInput.fileMenuTitle')}</span>
							{fileQuery?.directory && (
								<span className="min-w-0 truncate font-mono text-xs font-normal text-muted-foreground">
									{fileQuery.directory}
								</span>
							)}
							{!fileMenuLoading && !fileMenuError && (
								<span className="ml-auto text-xs font-normal text-muted-foreground">
									{matchingFiles.length}
								</span>
							)}
						</div>

						<div className="max-h-72 overflow-y-auto p-1.5">
							{fileMenuLoading ? (
								<div className="flex h-20 items-center justify-center">
									<Loader2 className="size-4 animate-spin text-muted-foreground" />
								</div>
							) : fileMenuError ? (
								<div className="px-3 py-6 text-center text-sm text-destructive">
									{fileMenuError}
								</div>
							) : matchingFiles.length === 0 ? (
								<div className="px-3 py-6 text-center text-sm text-muted-foreground">
									{t('textInput.fileMenuEmpty')}
								</div>
							) : (
								matchingFiles.map((entry, index) => (
									<button
										key={entry.name}
										id={`${FILE_MENU_ID}-${index}`}
										type="button"
										role="option"
										aria-selected={index === activeFileIndex}
										onMouseDown={(event) => event.preventDefault()}
										onMouseEnter={() => setActiveFileIndex(index)}
										onClick={() => handleFileMentionSelect(entry)}
										className={cn(
											'flex w-full items-center gap-3 rounded-md px-2 py-2 text-left outline-none transition-colors',
											index === activeFileIndex &&
												'bg-accent text-accent-foreground',
										)}
									>
										{entry.is_dir ? (
											<Folder className="size-4 shrink-0 text-muted-foreground" />
										) : (
											<FileText className="size-4 shrink-0 text-muted-foreground" />
										)}
										<span className="min-w-0 flex-1 truncate text-sm">
											{entry.name}
										</span>
										<span className="shrink-0 text-xs text-muted-foreground">
											{entry.is_dir
												? t('textInput.fileFolder')
												: formatFileSize(entry.size_bytes)}
										</span>
									</button>
								))
							)}
						</div>
					</div>
				)}
				{showSkillMenu && (
					<div
						id={SKILL_MENU_ID}
						role="listbox"
						aria-label={t('textInput.skillMenuTitle')}
						className="absolute inset-x-1 bottom-full z-[60] mb-2 overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-lg"
					>
						<div className="flex h-10 items-center gap-2 border-b px-3 text-sm font-medium">
							<BookText className="size-4 text-muted-foreground" />
							<span>{t('textInput.skillMenuTitle')}</span>
							{!installedSkillsLoading && (
								<span className="ml-auto text-xs font-normal text-muted-foreground">
									{matchingSkills.length}
								</span>
							)}
						</div>

						<div className="max-h-72 overflow-y-auto p-1.5">
							{installedSkillsLoading ? (
								<div className="flex h-20 items-center justify-center">
									<Loader2 className="size-4 animate-spin text-muted-foreground" />
								</div>
							) : matchingSkills.length === 0 ? (
								<div className="px-3 py-6 text-center text-sm text-muted-foreground">
									{installedSkills.length === 0
										? t('textInput.skillMenuEmpty')
										: t('textInput.skillMenuNoMatch')}
								</div>
							) : (
								matchingSkills.map((skill, index) => {
									const equipped = workspaceSkillNames.has(skill.name);
									const adding = addingSkillId === skill.id;
									return (
										<button
											key={skill.id}
											id={`${SKILL_MENU_ID}-${index}`}
											type="button"
											role="option"
											aria-selected={index === activeSkillIndex}
											disabled={addingSkillId !== null}
											onMouseDown={(event) => event.preventDefault()}
											onMouseEnter={() => setActiveSkillIndex(index)}
											onClick={() => void handleSkillSelect(skill)}
											className={cn(
												'flex w-full items-center gap-3 rounded-md px-2 py-2 text-left outline-none transition-colors',
												index === activeSkillIndex &&
													'bg-accent text-accent-foreground',
												addingSkillId !== null && 'cursor-wait',
											)}
										>
											<Avatar className="size-8 rounded-md">
												<AvatarImage
													src={skill.icon_url ?? undefined}
													alt=""
												/>
												<AvatarFallback className="rounded-md text-xs font-medium">
													{(skill.display_name || skill.name)
														.slice(0, 1)
														.toUpperCase()}
												</AvatarFallback>
											</Avatar>
											<span className="min-w-0 flex-1">
												<span className="flex items-baseline gap-2">
													<span className="truncate text-sm font-medium">
														{skill.display_name || skill.name}
													</span>
													<span className="hidden shrink-0 font-mono text-xs text-muted-foreground sm:inline">
														/{skill.name}
													</span>
												</span>
												<span className="block truncate text-xs text-muted-foreground">
													{skill.description}
												</span>
											</span>
											<span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
												{adding ? (
													<Loader2 className="size-3.5 animate-spin" />
												) : equipped ? (
													<Check className="size-3.5" />
												) : (
													<Plus className="size-3.5" />
												)}
												<span className="hidden sm:inline">
													{equipped
														? t('textInput.skillInWorkspace')
														: t('textInput.skillAddToWorkspace')}
												</span>
											</span>
										</button>
									);
								})
							)}
						</div>

						{skillError && (
							<div className="border-t px-3 py-2 text-xs text-destructive">
								{skillError}
							</div>
						)}
					</div>
				)}
				{headerSlot}
				<div
					id="tour-chat-input"
					className="flex w-full flex-col rounded-[28px] border bg-background px-2"
					data-tour="chat-input"
				>
					{files.length > 0 && (
						<AttachmentGroup className={'w-full max-w-full px-1 mt-1'}>
							{files.map((file, index) => {
								const isImage =
									file.block &&
									file.block.type === 'data' &&
									file.block.source.media_type.startsWith('image/');
								let data: undefined | string;
								if (file.block && file.block.type === 'data') {
									const block = file.block;
									data =
										block.source.type === 'url'
											? block.source.url
											: `data:${block.source.media_type};base64,${block.source.data}`;
								}

								return (
									<Attachment>
										<AttachmentMedia variant={isImage ? 'image' : 'icon'}>
											{file.status === 'processing' ? (
												<Loader2 className="size-3 shrink-0 animate-spin" />
											) : isImage ? (
												<img src={data} alt={file.name} />
											) : (
												<FileText className="size-3" />
											)}
										</AttachmentMedia>
										<AttachmentContent>
											<AttachmentTitle>{file.name}</AttachmentTitle>
											<AttachmentDescription>
												{file.status === 'processing'
													? t('common.uploading')
													: (
															mime.getExtension(
																mime.getType(file.name) || 'bin',
															) || 'bin'
														).toUpperCase()}
											</AttachmentDescription>
										</AttachmentContent>
										<AttachmentActions>
											<AttachmentAction
												onClick={() =>
													setFiles(files.filter((_, i) => i !== index))
												}
											>
												<XIcon />
											</AttachmentAction>
										</AttachmentActions>
									</Attachment>
								);
							})}
						</AttachmentGroup>
					)}

					{/* ``items-end`` in both layouts: the buttons are then already at the
					    bottom before stacking moves them there, so nothing jumps. */}
					<div className="relative flex flex-wrap items-end justify-end">
						{/* Ghost row, always laid out side-by-side, so the width it hands
						    the text is the narrow one whichever layout is on screen. */}
						<div
							aria-hidden
							className="pointer-events-none invisible absolute inset-x-0 top-0 flex h-0 items-start overflow-hidden"
						>
							<div className="min-w-0 flex-1">
								{/* Padding-x and line-height decide where text wraps, so they
								    match the textarea; padding-y is left off on purpose. */}
								<span
									ref={measureRef}
									className="block text-sm"
									style={{
										paddingLeft: `${TEXTAREA_PADDING_X_PX}px`,
										paddingRight: `${TEXTAREA_PADDING_X_PX}px`,
										lineHeight: `${LINE_HEIGHT_PX}px`,
										whiteSpace: 'pre-wrap',
										wordWrap: 'break-word',
									}}
								>
									{value}
								</span>
							</div>
							{/* Stands in for the button cluster below — keep the count, the
							    gap and the ``size-9`` footprint in step with it. */}
							<div className="flex shrink-0 gap-2">
								<div className="size-9" />
								<div className="size-9" />
								<div className="size-9" />
							</div>
						</div>

						{/* ``min-w-0`` lets the textarea shrink instead of pushing the
						    buttons out of the row once the text gets long. */}
						<div
							className={cn('relative min-w-0', isStacked ? 'basis-full' : 'flex-1')}
						>
							{/* ``block`` — inline-block would sit on the text baseline and
							    leave a descender gap that makes the wrapper taller. */}
							<textarea
								ref={textareaRef}
								value={value}
								onChange={(e) => {
									const nextValue = e.target.value;
									setValue(nextValue);
									setCursorPosition(e.target.selectionStart ?? nextValue.length);
									setDismissedFileMention(null);
									setSkillMenuForced(false);
									setSkillMenuOpen(skillSlashQuery(nextValue) !== null);
									setSkillError(null);
								}}
								onKeyDown={handleKeyDown}
								onFocus={() => {
									setIsFocused(true);
									setCursorPosition(
										textareaRef.current?.selectionStart ?? value.length,
									);
									if (skillSlashQuery(value) !== null) setSkillMenuOpen(true);
								}}
								onSelect={(e) => {
									setCursorPosition(
										e.currentTarget.selectionStart ?? value.length,
									);
								}}
								onBlur={() => setIsFocused(false)}
								placeholder={defaultPlaceholder}
								disabled={disabled}
								rows={1}
								className="block w-full resize-none rounded-md border-0 bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
								style={{
									minHeight: `${COLLAPSED_HEIGHT_PX}px`,
									maxHeight: `${MAX_HEIGHT_PX}px`,
									lineHeight: `${LINE_HEIGHT_PX}px`,
									paddingTop: `${TEXTAREA_PADDING_Y_PX}px`,
									paddingBottom: `${TEXTAREA_PADDING_Y_PX}px`,
									overflowY: 'auto',
								}}
								autoFocus={true}
								role="combobox"
								aria-autocomplete="list"
								aria-controls={
									showFileMenu
										? FILE_MENU_ID
										: showSkillMenu
											? SKILL_MENU_ID
											: undefined
								}
								aria-expanded={showFileMenu || showSkillMenu}
								aria-activedescendant={
									showFileMenu && matchingFiles.length > 0
										? `${FILE_MENU_ID}-${activeFileIndex}`
										: showSkillMenu && matchingSkills.length > 0
											? `${SKILL_MENU_ID}-${activeSkillIndex}`
											: undefined
								}
							/>

							{/* Autocomplete overlay — its padding and line-height mirror the
							    textarea's, or the suggestion drifts off the real text. */}
							{suggestion && isFocused && (
								<div
									className="pointer-events-none absolute left-0 top-0 px-3 text-sm"
									style={{
										lineHeight: `${LINE_HEIGHT_PX}px`,
										paddingTop: `${TEXTAREA_PADDING_Y_PX}px`,
										paddingBottom: `${TEXTAREA_PADDING_Y_PX}px`,
										whiteSpace: 'pre-wrap',
										wordWrap: 'break-word',
									}}
								>
									{/* Invisible input text */}
									<span className="invisible">{value}</span>
									{/* Suggestion text */}
									<span className="text-muted-foreground">{suggestion}</span>
									{/* Tab hint */}
									<span className="ml-2 text-xs text-muted-foreground/60">
										<Kbd>Tab</Kbd> {t('textInput.toComplete')}
									</span>
								</div>
							)}
						</div>

						{/* Collapsed-height box centring the buttons, so a single line still
						    reads as centred while the row bottom-aligns them. */}
						<div
							className="flex shrink-0 items-center gap-2"
							style={{ height: `${COLLAPSED_HEIGHT_PX}px` }}
						>
							{/* Installed skill slash-command menu */}
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										type="button"
										variant="ghost"
										size="icon-lg"
										aria-label={t('textInput.chooseSkill')}
										disabled={disabled || phase !== 'idle'}
										onClick={() => {
											setSkillError(null);
											setSkillMenuForced(true);
											setSkillMenuOpen(true);
											setActiveSkillIndex(0);
											requestAnimationFrame(() =>
												textareaRef.current?.focus(),
											);
										}}
										className="shrink-0 rounded-full"
									>
										<BookText className="size-4" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>{t('textInput.chooseSkill')}</TooltipContent>
							</Tooltip>

							{/* Attachment button */}
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										type="button"
										variant="ghost"
										size="icon-lg"
										onClick={() => fileInputRef.current?.click()}
										disabled={attachDisabled}
										className="shrink-0 rounded-full"
									>
										<Paperclip className="size-4" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									{attachDisabled && allowedInputTypes?.length === 0
										? t('textInput.attachNotSupported')
										: t('textInput.attach')}
								</TooltipContent>
							</Tooltip>

							{/* Send / Stop button — driven by ``sendButton`` config */}
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										type="button"
										onClick={sendButton.onClick}
										disabled={sendButton.disabled}
										size="icon-lg"
										className="shrink-0 rounded-full"
									>
										<sendButton.icon className="h-4 w-4" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>{sendButton.tooltip}</TooltipContent>
							</Tooltip>

							{/* Hidden file input */}
							<input
								ref={fileInputRef}
								type="file"
								multiple
								accept={acceptAttr}
								onChange={handleFileSelect}
								className="hidden"
							/>
						</div>
					</div>
				</div>
			</div>
		);
	},
);

TextInput.displayName = 'TextInput';
