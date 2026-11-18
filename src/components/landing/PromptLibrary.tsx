import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  ArrowUpRight,
  Check,
  Copy,
  LayoutGrid,
  Palette,
  RefreshCw,
  Rocket,
  Wrench,
  Play,
  type LucideIcon,
} from 'lucide-react';
import { BrandLogo } from '@/components/BrandLogo';
import { FilmDialog } from './FilmDialog';
import { getFilm } from './films';

type PromptGroup = {
  title: string;
  prompts: string[];
};

type PromptCategory = {
  id: string;
  label: string;
  icon: LucideIcon;
  accent: string;
  heading: string;
  description: string;
  groups: PromptGroup[];
};

const PROMPT_CATEGORIES: PromptCategory[] = [
  {
    id: 'update',
    label: 'Update the app',
    icon: RefreshCw,
    accent: 'var(--fb-lime)',
    heading: 'Update what already works',
    description:
      'Rename things, change copy, reorder screens and add flows. The agent edits the Dart files in place and keeps the preview running.',
    groups: [
      {
        title: 'Content updates',
        prompts: [
          'Rename the app to "Orbit" everywhere - app title, splash text, settings, empty states and the README.',
          'Change the Pro plan from $29/mo to $39/mo and add an Enterprise tier with custom pricing.',
          'Find every screen that says "2025" and update it to 2026.',
        ],
      },
      {
        title: 'Layout changes',
        prompts: [
          'Reorganize the features section into a 2x3 grid of cards instead of a vertical list.',
          'Move the streak card above the weekly checklist and make the primary action stick to the bottom.',
          'Redesign the home screen so the hero takes the full viewport and quick actions sit in a horizontal rail.',
        ],
      },
      {
        title: 'Flows & features',
        prompts: [
          'Add a contact form screen with name, email and message fields, validation and a success state.',
          'Add an FAQ screen with six expandable questions read from a local JSON file.',
          'Add a testimonials carousel to the pricing screen with three placeholder entries.',
        ],
      },
    ],
  },
  {
    id: 'style',
    label: 'Restyle the app',
    icon: Palette,
    accent: 'var(--fb-magenta)',
    heading: 'Describe the look. The agent restyles it.',
    description:
      'Colors, typography, components and motion are edited through the project theme, so every screen changes together and stays editable.',
    groups: [
      {
        title: 'Colors & themes',
        prompts: [
          'Replace the old orange accent (#FF5733) with our new brand color (#E94560) everywhere on the app.',
          'Switch the whole app to dark mode with dark surfaces, light text and updated component colors.',
          'Update the theme to use primary #1A1A2E, accent #E94560 and a light background #F5F5F5.',
        ],
      },
      {
        title: 'Typography',
        prompts: [
          'Update the app typography: Fraunces for headings and Inter for body text.',
          'Establish a consistent type scale: H1 64px, H2 48px, H3 36px and body 18px across every screen.',
          'Give the headings a tight, editorial feel with italic support and apply it everywhere.',
        ],
      },
      {
        title: 'Components & motion',
        prompts: [
          'Make every primary button fully rounded, filled with the brand color and white text.',
          'Refresh the cards: new corner radius, softer shadows and updated border colors across the app.',
          'Add staggered fade-in animations to the feature cards and scroll-triggered reveals to each screen.',
        ],
      },
    ],
  },
  {
    id: 'add',
    label: 'Add screens',
    icon: LayoutGrid,
    accent: 'var(--fb-cyan)',
    heading: 'Build the screens you are missing',
    description:
      'Describe a screen, a data flow or a breakpoint. The agent writes the widgets, wires the state and keeps the project buildable.',
    groups: [
      {
        title: 'New screens',
        prompts: [
          'Add an onboarding flow with three steps, a skip action and a final "Get started" screen.',
          'Add a settings screen for theme, reminders and units, persisted on the device.',
          'Add a searchable list screen with empty, loading and error states.',
        ],
      },
      {
        title: 'Data & state',
        prompts: [
          'Add a local habits repository with create, edit, complete and delete actions that survives a restart.',
          'Connect the app to Supabase for auth and synced data, with a local-only fallback.',
          'Replace the hardcoded sample data with a typed model and a repository the screens read from.',
        ],
      },
      {
        title: 'Responsive',
        prompts: [
          'Make every screen responsive: two columns on tablet and a single stack on mobile.',
          'The navigation should collapse into a drawer under 700px and keep the current route highlighted.',
          'Fix the desktop layout so content is centered with a max width instead of stretching full screen.',
        ],
      },
    ],
  },
  {
    id: 'fix',
    label: 'Fix & audit',
    icon: Wrench,
    accent: 'var(--fb-orange)',
    heading: 'Fix and audit the project',
    description:
      'The agent reads analyzer output, finds broken states and cleans up inconsistencies before they reach the export.',
    groups: [
      {
        title: 'Compile & runtime',
        prompts: [
          'Fix the overflow error in the profile header on screens narrower than 360px.',
          'The build fails in lib/screens/home_screen.dart. Read the analyzer output and repair it.',
          'Find every unused import, dead widget and hardcoded color and clean them up.',
        ],
      },
      {
        title: 'Accessibility',
        prompts: [
          'Add semantic labels to every icon button and make sure tap targets are at least 48px.',
          'Check every screen for text smaller than 12px or low contrast, then fix it.',
          'Add descriptive semantics to every image and give the forms proper labels and error messages.',
        ],
      },
      {
        title: 'Consistency',
        prompts: [
          'Audit heading sizes, button styles and spacing across all screens and make them uniform.',
          'Find hardcoded colors and spacing values and replace them with theme tokens.',
          'Check the navigation for dead ends and add a back route wherever one is missing.',
        ],
      },
    ],
  },
  {
    id: 'ship',
    label: 'Ship & export',
    icon: Rocket,
    accent: 'var(--fb-lime)',
    heading: 'Leave with an app you own',
    description:
      'Prepare desktop runners, check the release details and keep the project portable. The export is ordinary Flutter source.',
    groups: [
      {
        title: 'Desktop targets',
        prompts: [
          'Prepare a macOS runner folder and tell me exactly what still needs signing before release.',
          'Create the Windows runner and list the files I need to build the installer.',
          'Set up a web build profile and verify that the preview still compiles cleanly.',
        ],
      },
      {
        title: 'Release prep',
        prompts: [
          'Bump the app version to 1.2.0, update the changelog and check the build number for every target.',
          'Audit the release build for debug banners, test keys and placeholder copy.',
          'Add a README that explains how to run, build and export this project without FlutterForge.',
        ],
      },
    ],
  },
];

const CATEGORY_FILMS: Record<string, { filmId: string; poster: string }> = {
  update: { filmId: '01-update', poster: '/films/01-update.jpg' },
  style: { filmId: '02-restyle', poster: '/films/02-restyle.jpg' },
  add: { filmId: '03-add', poster: '/films/03-add.jpg' },
  fix: { filmId: '04-ship', poster: '/films/04-fix.jpg' },
  ship: { filmId: '04-ship', poster: '/films/04-ship-export.jpg' },
};

function CategoryFilm({ category }: { category: PromptCategory }) {
  const [open, setOpen] = useState(false);
  const config = CATEGORY_FILMS[category.id];
  const film = config ? getFilm(config.filmId) : undefined;
  if (!film) return null;
  return (
    <div className="agents-film-feature" style={{ '--film-accent': film.accent } as CSSProperties}>
      <div className="agents-film-feature-bar">
        <span><BrandLogo size={18} alt="" /> FlutterForge</span>
        <span>{film.num} / 04 · {film.duration} · Live capture</span>
      </div>
      <button
        type="button"
        className="agents-film-feature-stage"
        onClick={() => setOpen(true)}
        aria-label={`Play the ${film.title} film, ${film.duration}`}
      >
        <img src={config.poster} alt="" width={1280} height={720} loading="lazy" decoding="async" />
        <span className="agents-film-feature-play" aria-hidden="true"><Play size={22} fill="currentColor" /></span>
      </button>
      {open && <FilmDialog film={film} poster={config.poster} onClose={() => setOpen(false)} />}
    </div>
  );
}

async function writeToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path when the clipboard API is blocked.
  }

  const previousFocus = document.activeElement;
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.appendChild(field);
  field.focus();
  field.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
    if (previousFocus instanceof HTMLElement) previousFocus.focus({ preventScroll: true });
  }
}

export function PromptLibrary({ onUsePrompt }: { onUsePrompt: (prompt: string) => void }) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);
  const [activeCategory, setActiveCategory] = useState('update');
  const copyTimer = useRef<number>();
  const libraryRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => window.clearTimeout(copyTimer.current), []);
  useEffect(() => {
    const library = libraryRef.current;
    if (!library) return;
    const desktop = window.matchMedia('(min-width: 900px) and (min-height: 650px)');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sections = Array.from(library.querySelectorAll<HTMLElement>('.agents-category'));
    const stacks = sections.map(section => Array.from(section.querySelectorAll<HTMLElement>('.agents-stack-card')));
    let frame = 0;
    const update = () => {
      frame = 0;
      const enabled = desktop.matches && !reducedMotion.matches;
      let active = sections[0].id;
      sections.forEach(section => {
        if (section.getBoundingClientRect().top <= window.innerHeight * 0.35) active = section.id;
      });
      setActiveCategory(active);
      stacks.forEach(cards => cards.forEach((card, index) => {
        const next = cards[index + 1];
        const surface = card.firstElementChild as HTMLElement;
        const progress = enabled && next && card.offsetHeight
          ? Math.min(1, Math.max(0, 1 - (next.getBoundingClientRect().top - 112) / card.offsetHeight)) : 0;
        surface.style.transform = progress ? `scale(${1 - progress * 0.045})` : '';
        surface.style.filter = progress ? `brightness(${1 - progress * 0.3})` : '';
        card.inert = progress >= 0.999;
        const coverTop = next?.getBoundingClientRect().top ?? Infinity;
        card.querySelectorAll<HTMLButtonElement>('button').forEach(button => {
          button.inert = progress > 0 && progress < 0.999 && button.getBoundingClientRect().bottom > coverTop;
        });
      }));
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule);
    observer.observe(library);
    update();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    desktop.addEventListener('change', schedule);
    reducedMotion.addEventListener('change', schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      desktop.removeEventListener('change', schedule);
      reducedMotion.removeEventListener('change', schedule);
      observer.disconnect();
    };
  }, []);

  async function copyPrompt(key: string, prompt: string) {
    const copied = await writeToClipboard(prompt);
    setCopiedKey(copied ? key : null);
    setCopyError(!copied);
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => { setCopiedKey(null); setCopyError(false); }, 1800);
  }

  return (
    <div ref={libraryRef} className="agents-library">
      <nav className="agents-categories" aria-label="Explore what you can build">
        {PROMPT_CATEGORIES.map(category => <a key={category.id} href={`#${category.id}`}><category.icon size={23} strokeWidth={1.5} /><span>{category.label}<ArrowUpRight size={14} /></span></a>)}
      </nav>
      <div className="agents-sequences">
        <div className="agents-rail-track"><nav className="agents-section-rail" aria-label="Prompt categories">
          {PROMPT_CATEGORIES.map(category => <a key={category.id} href={`#${category.id}`} aria-label={category.label} title={category.label} aria-current={activeCategory === category.id ? 'location' : undefined}><category.icon size={18} strokeWidth={1.5} /></a>)}
        </nav></div>
        {PROMPT_CATEGORIES.map(category => (
          <section key={category.id} id={category.id} className="agents-category" data-category={category.id} aria-labelledby={`${category.id}-title`}>
            <div className="agents-category-intro">
              <div className="agents-ribbons" aria-hidden="true"><i /><i /><i /></div>
              <div className="agents-category-copy"><h2 id={`${category.id}-title`}>{category.heading}</h2><p>{category.description}</p></div>
            </div>
            <div className="agents-card-stack">
              <div className="agents-stack-card"><div className="agents-stack-surface agents-film-surface"><CategoryFilm category={category} /></div></div>
              {category.groups.map(group => (
                <div key={group.title} className="agents-stack-card">
                  <article className="agents-stack-surface agents-prompt-group" aria-label={group.title}>
                    <h3>{group.title}</h3>
                    <ul>{group.prompts.map((prompt, index) => {
                      const key = `${category.id}:${group.title}:${index}`;
                      const copied = copiedKey === key;
                      return <li key={key}>
                        <button type="button" className="agents-use-prompt" aria-label={`Use prompt: ${prompt}`} onClick={() => onUsePrompt(prompt)}><span>{prompt}</span><ArrowUpRight size={15} /></button>
                        <button type="button" className="agents-copy-prompt" onClick={() => void copyPrompt(key, prompt)} aria-label={copied ? 'Prompt copied' : `Copy prompt: ${prompt}`} title={copied ? 'Copied' : 'Copy prompt'}>{copied ? <Check size={17} /> : <Copy size={17} />}</button>
                      </li>;
                    })}</ul>
                  </article>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
      <span className="sr-only" role="status">{copyError ? 'Could not copy. Select the prompt to use it in the builder.' : copiedKey ? 'Prompt copied to clipboard.' : ''}</span>
    </div>
  );
}
