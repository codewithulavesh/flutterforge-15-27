import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowDown, ArrowRight, ArrowUpRight, Check, Code2, Github, Globe2, Monitor, Play, Plus } from 'lucide-react';
import { useReducedMotion } from 'motion/react';
import Lenis from 'lenis';
import { BrandLogo } from '@/components/BrandLogo';
import { PromptLibrary } from '@/components/landing/PromptLibrary';
import { Pricing } from '@/components/blocks/pricing';
import { LANDING_PLANS } from '@/components/blocks/pricing-plans';
import { useAuthStore } from '@/stores/auth.store';
import { HERO_PROMPT_KEY } from '@/utils/landing';
import './agents-landing.css';

const REPO = 'https://github.com/codewithulavesh/flutterforge';
const EXAMPLES = [
  { label: 'Personal finance', prompt: 'Build a personal finance app with category budgets, a monthly spending chart, and recurring bills.' },
  { label: 'Recipe planner', prompt: 'Create a recipe planner with a weekly meal calendar, grocery list, and dietary filters.' },
  { label: 'Fitness tracker', prompt: 'Design a fitness habit tracker with weekly progress, workout cards, and streaks.' },
];
const FAQS = [
  { q: 'Do I need Flutter installed?', a: 'No manual install is needed for web preview. FlutterForge reuses a compatible SDK if you have one, or downloads the official stable SDK on first preview. That first setup needs internet access and disk space. Android and iOS builds still need their platform toolchains.' },
  { q: 'Where does the AI run?', a: 'The workspace and Flutter preview run on your computer. Prompts and relevant project context are sent to the AI provider configured for your account or deployment.' },
  { q: 'Is Supabase required?', a: 'No. Auto mode checks whether the request needs accounts, shared data, realtime or commerce. A calculator or timer is generated as a local-only app.' },
  { q: 'What happens when code does not compile?', a: 'The preview compiler reports the errors, the agent receives them with the active file and build context, and it repairs the project. Two automatic repair rounds are attempted.' },
  { q: 'Can I ship the generated app?', a: 'Export the editable Flutter project and build it with the toolchain for your target. FlutterForge can prepare macOS and Windows runner folders; signing and store submission remain part of your release process.' },
];
const TEAM = [
  { name: 'Shradha Takkekar', role: 'Full-stack & UX architecture' },
  { name: 'Srushti Churamari', role: 'Compiler & runtime pipeline' },
  { name: 'Vijeta Kotnikallamath', role: 'AI agent & context synthesis' },
  { name: 'Ulavayya Karaguppi', role: 'Core engine & desktop bridge' },
];
const TABS = ['preview', 'source', 'build'] as const;
const TAB_LABELS = { preview: 'Preview', source: 'Source', build: 'Build log' };
const SOURCE = `import 'package:flutter/material.dart';

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Orbit')),
      body: ListView(
        padding: const EdgeInsets.all(24),
        children: const [
          Text('A little better, every day.'),
          ListTile(title: Text('Morning run')),
          ListTile(title: Text('Read 20 pages')),
          ListTile(title: Text('Stretch')),
        ],
      ),
    );
  }
}`;

export function AgentsLandingPage() {
  const navigate = useNavigate();
  const session = useAuthStore(state => state.session);
  const reduced = useReducedMotion() ?? false;
  const [prompt, setPrompt] = useState('');
  const [tab, setTab] = useState<(typeof TABS)[number]>('preview');
  const [showDock, setShowDock] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const promptRef = useRef<HTMLInputElement>(null);
  const lenisRef = useRef<Lenis | null>(null);
  const workspaceHref = session ? '/dashboard' : '/signup';

  useEffect(() => {
    const title = document.title;
    document.title = 'FlutterForge Agents — Your build partner';
    const anchor = window.location.hash.slice(1);
    if (anchor) document.getElementById(anchor)?.scrollIntoView();
    else window.scrollTo({ top: 0, behavior: 'instant' });
    return () => { document.title = title; };
  }, []);

  useEffect(() => {
    if (reduced) return;
    const lenis = new Lenis({ autoRaf: true, duration: 1.15, smoothWheel: true, anchors: true });
    lenisRef.current = lenis;
    return () => { lenis.destroy(); lenisRef.current = null; };
  }, [reduced]);

  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const observer = new IntersectionObserver(([entry]) => setShowDock(!entry.isIntersecting), { rootMargin: '80px 0px 0px 0px' });
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const elements = pageRef.current?.querySelectorAll<HTMLElement>('[data-reveal]');
    if (!elements || reduced) return;
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.08 });
    elements.forEach(element => { element.classList.add('will-reveal'); observer.observe(element); });
    return () => observer.disconnect();
  }, [reduced]);

  function selectPrompt(text: string) {
    setPrompt(text);
    if (lenisRef.current) lenisRef.current.scrollTo('#start');
    else document.getElementById('start')?.scrollIntoView({ behavior: 'instant', block: 'center' });
    promptRef.current?.focus({ preventScroll: true });
  }

  function submitPrompt() {
    const text = prompt.trim();
    if (!text) return;
    try { sessionStorage.setItem(HERO_PROMPT_KEY, text); }
    catch { /* Navigation state still carries the brief when storage is blocked. */ }
    navigate(workspaceHref, { state: { heroPrompt: text } });
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const current = TABS.indexOf(tab);
    const next = event.key === 'ArrowRight' ? (current + 1) % TABS.length
      : event.key === 'ArrowLeft' ? (current + TABS.length - 1) % TABS.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    setTab(TABS[next]);
    document.getElementById(`workbench-tab-${TABS[next]}`)?.focus();
  }

  return (
    <div ref={pageRef} className="ff-agents">
      <a href="#hero" className="agents-skip">Skip to content</a>
      <header ref={headerRef} className="agents-header agents-container">
        <nav aria-label="Agents navigation">
          <Link to="/">Home</Link>
          <a href="#hero" aria-current="page">Agents</a>
          <a href="#prompts">Prompts</a>
          <a href="#pricing">Plans</a>
          <Link to={workspaceHref} aria-label={session ? 'Open studio' : 'Start building'}><ArrowUpRight aria-hidden="true" /></Link>
        </nav>
      </header>
      {showDock && <nav className="agents-dock" aria-label="Agents quick navigation">
        <Link to="/">Home</Link>
        <a href="#hero" aria-current="page">Agents</a>
        <a href="#prompts">Prompts</a>
        <a href="#pricing">Plans</a>
        <Link className="agents-dock-cta" to={workspaceHref}>{session ? 'Studio' : 'Build'}<ArrowUpRight size={17} aria-hidden="true" /></Link>
      </nav>}

      <main>
        <section id="hero" className="agents-hero agents-container">
          <p className="agents-hero-label"><BrandLogo size={22} alt="" /> FlutterForge <span>/ Agents</span></p>
          <h1>Your next<br /><span>build partner.</span></h1>
          <div className="agents-hero-layout">
            <div className="agents-hero-copy">
              <p className="agents-hero-description">Big idea. Small update.<br />An agent for every next step.</p>
              <p className="agents-hero-note">Build, refine, and ship a Flutter app through conversation. Real source code. A local preview. Always yours.</p>
              <div className="agents-hero-actions"><a className="agents-button agents-button-primary" href="#start">Start building <ArrowUpRight size={20} /></a><a className="agents-text-link" href="#update">Watch the films <Play size={13} fill="currentColor" /></a></div>
            </div>
            <div className="agents-hero-art" aria-label="Illustrative agent workflow: a brief becomes editable Flutter files">
              <div className="agents-brief-card"><span>Your brief <ArrowUpRight size={17} /></span><p>“A habit tracker that makes<br />showing up feel good.”</p></div>
              <div className="agents-file-card"><div><Code2 size={22} /><span>Made of real Flutter.</span></div><p><span>lib /</span> main.dart <Check size={16} /></p><p><span>screens /</span> home_screen.dart <Check size={16} /></p><p><span>theme /</span> app_theme.dart <Check size={16} /></p><a href="#workbench">Explore the workbench <ArrowUpRight size={17} /></a></div>
              <span className="agents-art-caption">Example workflow · not a live generation</span>
            </div>
          </div>
          <div className="agents-hero-foot"><span>From the first idea to the finishing touches.</span><a href="#prompts">Explore the possibilities <ArrowDown size={17} /></a></div>
        </section>

        <section id="start" className="agents-container agents-start agents-section" data-reveal>
          <p className="agents-kicker">A good place to start</p>
          <h2>You bring the idea.<br />Let’s build the app.</h2>
          <p className="agents-muted">A screen, a tool, or the app you keep wishing existed.</p>
          <form onSubmit={event => { event.preventDefault(); submitPrompt(); }}>
            <label htmlFor="hero-prompt">Describe the app you want to build</label>
            <div className="agents-prompt-input"><input ref={promptRef} id="hero-prompt" value={prompt} onChange={event => setPrompt(event.target.value)} maxLength={2000} placeholder="A habit tracker with weekly goals…" /><button type="submit" className="agents-button agents-button-primary" disabled={!prompt.trim()}>Build this app <ArrowUpRight size={18} /></button></div>
          </form>
          <div className="agents-examples"><span>Try an idea</span>{EXAMPLES.map(example => <button type="button" key={example.label} onClick={() => selectPrompt(example.prompt)}>{example.label}<ArrowUpRight size={14} /></button>)}</div>
        </section>

        <section id="prompts" className="agents-container agents-library-section" aria-label="Explore FlutterForge agents">
          <div className="agents-section-heading" data-reveal><div><p className="agents-kicker">More than a first draft</p><h2>One partner.<br />Every next step.</h2></div><p>Watch it work, then try a prompt.<br />Choose one to make it your starting point, or copy it for later.</p></div>
          <PromptLibrary onUsePrompt={selectPrompt} />
        </section>

        <section id="workflow" className="agents-container agents-section" data-reveal>
          <div className="agents-section-heading"><div><p className="agents-kicker">A shorter path to a working app</p><h2>Describe. Build.<br />Make it yours.</h2></div><p>One conversation, real files, and a preview that keeps you close to what you’re making.</p></div>
          <div className="agents-workflow-grid">
            {[
              ['01', 'Start a conversation', 'Describe your screens and how they should work. The agent turns your brief into a Flutter project.'],
              ['02', 'See it take shape', 'Run a local web preview. Compiler errors feed back to the agent for up to two automatic repair rounds.'],
              ['03', 'Keep making it better', 'Ask for the next change, inspect the source, or export the project and continue in your own tools.'],
            ].map(([number, title, body]) => <article key={number}><span>{number}<ArrowUpRight size={22} /></span><h3>{title}</h3><p>{body}</p></article>)}
          </div>
        </section>

        <section id="workbench" className="agents-container agents-section" data-reveal>
          <div className="agents-section-heading"><div><p className="agents-kicker">Inside the workbench</p><h2>Your app.<br />Not a black box.</h2></div><Link className="agents-button agents-button-primary" to={workspaceHref}>Open the workbench <ArrowUpRight size={18} /></Link></div>
          <div className="agents-workbench">
            <div className="agents-workbench-bar"><span><BrandLogo size={20} alt="" /> Orbit <small>Illustrative project</small></span><div role="tablist" aria-label="Workbench view" onKeyDown={onTabKeyDown}>{TABS.map(id => <button key={id} type="button" id={`workbench-tab-${id}`} role="tab" aria-selected={tab === id} aria-controls="workbench-panel" tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)}>{TAB_LABELS[id]}</button>)}</div></div>
            <div id="workbench-panel" role="tabpanel" aria-labelledby={`workbench-tab-${tab}`} tabIndex={0} className="agents-workbench-panel">
              {tab === 'preview' && <div className="agents-workbench-preview"><div className="agents-preview-sidebar"><span>Project files</span><p><Code2 size={15} /> lib / main.dart</p><p><Code2 size={15} /> screens / home_screen.dart</p><p><Code2 size={15} /> theme / app_theme.dart</p><div><Check size={18} /><p>Editable Flutter source.<br />No proprietary runtime.</p></div></div><div className="agents-preview-canvas"><div className="agents-preview-app"><span className="agents-kicker">orbit</span><h3>A little better,<br />every day.</h3><div className="agents-preview-progress"><span>This week</span><strong>4 <small>/ 7 days</small></strong><div>{[35, 65, 50, 85, 70, 25, 20].map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}</div></div>{['Morning run', 'Read 20 pages', 'Stretch'].map((habit, index) => <p key={habit}><span>{index < 2 && <Check size={12} />}</span>{habit}</p>)}</div></div></div>}
              {tab === 'source' && <div className="agents-source-panel"><p>lib/screens/home_screen.dart <span>Dart</span></p><pre data-lenis-prevent><code>{SOURCE}</code></pre></div>}
              {tab === 'build' && <div className="agents-build-panel"><p>Example compiler and repair sequence</p><ol><li>Write the Flutter source files</li><li>Run <code>flutter analyze</code></li><li className="agents-build-warning">Analyzer reports an undefined name in home_screen.dart</li><li>Send the diagnostic and file context to the agent</li><li>Apply the repair and run the analyzer again</li><li><Check size={15} /> Start the local web preview when the build passes</li></ol><small>Illustration of the repair loop, not a live build.</small></div>}
            </div>
          </div>
          <div className="agents-feature-notes"><article><h3>Local where it matters</h3><p>Your workspace and Flutter preview run on your computer. Relevant context is sent to your configured AI provider.</p></article><article><h3>A backend when you need one</h3><p>Auto mode adds Supabase for accounts and shared data. A simple calculator or timer can stay local-only.</p></article></div>
        </section>

        <section id="desktop" className="agents-container agents-section agents-export" data-reveal>
          <div><p className="agents-kicker">Built to leave the studio</p><h2>No lock-in.<br />Just your app.</h2><p>Preview on the web, prepare desktop runners, and export an ordinary Flutter project. Signing and distribution stay in your hands.</p><Link to={workspaceHref} className="agents-text-link">Start building <ArrowUpRight size={18} /></Link></div>
          <div className="agents-export-targets">{[[Globe2, 'Web preview', 'Run locally in your browser'], [Monitor, 'macOS & Windows', 'Prepare desktop runner folders'], [Code2, 'Flutter source', 'Open, edit, and build anywhere']].map(([Icon, label, description]) => { const TargetIcon = Icon as typeof Globe2; return <div key={String(label)}><TargetIcon size={28} strokeWidth={1.5} /><div><h3>{String(label)}</h3><p>{String(description)}</p></div><ArrowUpRight size={20} /></div>; })}</div>
        </section>

        <Pricing plans={LANDING_PLANS} eyebrow="Plans for your next project" title="Room to build, at your pace." className="agents-pricing" />

        <section id="faq" className="agents-container agents-section agents-faq" data-reveal><div><p className="agents-kicker">Before you dive in</p><h2>Good<br />questions.</h2></div><div>{FAQS.map(item => <details key={item.q}><summary>{item.q}<Plus size={20} /></summary><p>{item.a}</p></details>)}</div></section>

        <section id="team" className="agents-container agents-section agents-team" data-reveal><div><p className="agents-kicker">The people behind the project</p><h2>Built in<br />Belagavi.</h2><p>A Phase 2 project by OnUs Devs at S. G. Balekundri Institute of Technology, VTU.</p></div><div className="agents-team-list">{TEAM.map(member => <div key={member.name}><h3>{member.name}</h3><p>{member.role}</p></div>)}</div></section>

        <section className="agents-container agents-final-cta" data-reveal><p className="agents-kicker">Your next idea is a conversation away.</p><h2>Less someday.<br />More start.</h2><a className="agents-button agents-button-primary" href="#start">Make it happen <ArrowUpRight size={20} /></a></section>
      </main>

      <footer className="agents-container agents-footer"><div className="agents-footer-main"><div><Link className="agents-brand" to="/"><BrandLogo size={28} alt="" />FlutterForge</Link><p>A local-first studio for real Flutter apps.</p><a href={REPO} target="_blank" rel="noreferrer" className="agents-text-link"><Github size={17} /> Source on GitHub <ArrowUpRight size={15} /></a></div><nav aria-label="Footer product"><h3>Product</h3><a href="#prompts">Explore agents</a><a href="#workflow">How it works</a><a href="#workbench">Workbench</a><a href="#desktop">Export</a><a href="#pricing">Pricing</a></nav><nav aria-label="Footer resources"><h3>Resources</h3><a href="#faq">FAQ</a><a href="#team">Project team</a><Link to={workspaceHref}>{session ? 'Dashboard' : 'Create account'}</Link>{!session && <><Link to="/login">Log in</Link><Link to="/forgot-password">Reset password</Link></>}</nav><nav aria-label="Legal"><h3>Legal</h3><Link to="/legal/terms">Terms of use</Link><Link to="/legal/privacy">Privacy notice</Link><Link to="/legal/permissions">Permissions</Link></nav></div><div className="agents-footer-bottom"><span>FlutterForge · OnUs Devs</span><a href="#hero">Back to top <ArrowRight size={16} /></a></div></footer>
    </div>
  );
}
