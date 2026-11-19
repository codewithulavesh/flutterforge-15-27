import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowDown, ArrowRight, ArrowUp, ArrowUpRight, Check, Code2, Github, Pause, Play, Sparkles } from 'lucide-react';
import { motion, useReducedMotion, useScroll, useTransform, type MotionValue, type Variants } from 'motion/react';
import Lenis from 'lenis';
import 'lenis/dist/lenis.css';
import { LimeCarousel } from '@/components/landing/LimeCarousel';
import { LANDING_PLANS } from '@/components/blocks/pricing-plans';
import { useAuthStore } from '@/stores/auth.store';
import { HERO_PROMPT_KEY } from '@/utils/landing';
import './lime-landing.css';

const ASSETS = '/landing-v2/';
const EASE = [0.22, 1, 0.36, 1] as const;
const FEATURES = [
  { title: 'From a little idea to a real Flutter app', body: 'Describe what you want to make. FlutterForge brings screens, state, and styling into a working project you can inspect, change, and make your own.' },
  { title: 'Your preview. Right beside your code.', body: 'See your Flutter app in a live web preview while you work. Move between the conversation and the source without moving between tools.' },
  { title: 'A build error is not the end of the story', body: 'Compiler feedback goes back to the agent with the project context. Two automatic repair rounds help turn a broken build into your next iteration.' },
  { title: 'Real files. Not a platform you are stuck in.', body: 'Keep the editable Dart source, project structure, and assets. Export your project and carry on with the Flutter tools you already know.' },
] as const;
const DETAILS = [
  { image: 'ff-detail-iterate', title: 'An AI that works with your project', body: 'Ask for a new screen, a different layout, or one more feature. Your brief and relevant source travel together, so each change starts with context—not a blank page.', label: 'Prompt & iterate' },
  { image: 'ff-detail-refine', title: 'Start small. Keep making it yours.', body: 'Try a simple idea first. Watch it take shape, test the interactions, and adjust the details in the same workspace. You decide what the next version needs.', label: 'Preview & refine' },
  { image: 'ff-detail-export', title: 'The next step is always yours', body: 'Take the Flutter source with you. Prepare web, macOS, or Windows targets, then use the platform toolchain to build, sign, and release your app.', label: 'Export & build' },
] as const;
const ANSWERS = [
  { title: 'Do I need Flutter installed?', body: 'Not for your first web preview. FlutterForge can reuse a compatible SDK or download the official stable SDK. First-time setup needs internet access and disk space.', eyebrow: 'Getting started' },
  { title: 'Does everything run locally?', body: 'The workspace and preview run on your machine. Prompts and relevant project context are sent to your configured AI provider. Local-first does not mean offline AI.', eyebrow: 'Your workspace' },
  { title: 'Can I ship the generated app?', body: 'Yes—export the editable Flutter project, review and test the code, then build with the toolchain for your target. Signing and store submission remain part of your release process.', eyebrow: 'Taking it further' },
] as const;
const TECHNOLOGIES = ['Flutter', 'Dart', 'Web preview', 'macOS', 'Windows', 'Local-first'];
const FEATURE_PHONES = [
  { image: 'ff-hero-builder', alt: 'AI builder concept screen' },
  { image: 'ff-hero-preview', alt: 'Live preview concept screen' },
  { image: 'ff-hero-source', alt: 'Generated source concept screen' },
  { image: 'ff-hero-iterate', alt: 'Iterating on a generated app concept screen' },
] as const;

function Reveal({ children, className = '' }: { children: ReactNode; className?: string }) {
  const reduced = useReducedMotion();
  return (
    <motion.div className={className} initial={reduced ? false : { opacity: 0, y: 40 }}
      whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.15 }}
      transition={{ duration: reduced ? 0 : 0.85, ease: EASE }}>
      {children}
    </motion.div>
  );
}

function Pill({ to, children, outline = false }: { to: string; children: ReactNode; outline?: boolean }) {
  return <Link className={`lv-pill${outline ? ' lv-pill-outline' : ''}`} to={to}>{children}<ArrowUpRight aria-hidden="true" size={24} /></Link>;
}

function PhoneStage({ reduced, eager = false }: { reduced: boolean; eager?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end start'] });
  const outerY = useTransform(scrollYProgress, [0, 1], [-28, 28]);
  const middleY = useTransform(scrollYProgress, [0, 1], [28, -28]);
  const phones = [
    { image: 'ff-hero-builder', alt: 'AI builder concept screen' },
    { image: 'ff-hero-preview', alt: 'Live app preview concept screen' },
    { image: 'ff-hero-source', alt: 'Generated Dart source concept screen' },
  ];
  return (
    <div ref={ref} className="lv-phone-stage" role="group" aria-label="FlutterForge workspace concept screens">
      {phones.map(({ image, alt }, index) => (
        <motion.img key={image} className={`lv-hero-phone lv-hero-phone-${index + 1}`} src={`${ASSETS}${image}.png`}
          alt={alt} width="496" height="1001" loading={eager ? 'eager' : 'lazy'} decoding="async"
          style={{ y: reduced ? 0 : index === 1 ? middleY : outerY }} />
      ))}
    </div>
  );
}

const STATEMENT_HEADLINE: Variants = {
  hidden: {},
  visible: { transition: { delayChildren: 0.12, staggerChildren: 0.075 } },
};
const STATEMENT_WORD: Variants = {
  hidden: { y: '112%' },
  visible: { y: '0%', transition: { duration: 0.85, ease: EASE } },
};
const STATEMENT_NOTE: Variants = {
  hidden: { opacity: 0, y: 18 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.8, delay: 0.55, ease: EASE } },
};
const STATEMENT_RULE: Variants = {
  hidden: { scaleX: 0 },
  visible: { scaleX: 1, transition: { duration: 0.8, delay: 1.05, ease: EASE } },
};

function StatementHeadline({ lines, reduced }: { lines: readonly (readonly string[])[]; reduced: boolean }) {
  return (
    <motion.h2
      className="lv-statement-title"
      variants={STATEMENT_HEADLINE}
      initial={reduced ? false : 'hidden'}
      whileInView={reduced ? undefined : 'visible'}
      viewport={{ once: true, amount: 0.35 }}>
      {lines.map((line) => (
        <span className="lv-statement-line" key={line.join(' ')}>
          {line.map((word, wordIndex) => (
            <Fragment key={`${word}-${wordIndex}`}>
              <span className="lv-statement-word">
                <motion.span className="lv-statement-word-inner" variants={STATEMENT_WORD}>{word}</motion.span>
              </span>
              {wordIndex < line.length - 1 ? ' ' : null}
            </Fragment>
          ))}
        </span>
      ))}
    </motion.h2>
  );
}

function Statement({ closing = false, reduced }: { closing?: boolean; reduced: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end start'] });
  const up = useTransform(scrollYProgress, [0, 1], [30, -30]);
  const down = useTransform(scrollYProgress, [0, 1], [-30, 30]);
  const tiltA = useTransform(scrollYProgress, [0, 1], [-2.2, 1.8]);
  const tiltB = useTransform(scrollYProgress, [0, 1], [2.2, -1.8]);
  const glowX = useTransform(scrollYProgress, [0, 1], [-36, 44]);
  const glowY = useTransform(scrollYProgress, [0, 1], [26, -26]);
  return (
    <div ref={ref} className={`lv-statement-wrap lv-inset${closing ? ' lv-statement-closing' : ''}`}>
      <div className="lv-statement lv-metal">
        <motion.div className="lv-statement-glow lv-statement-glow-a" aria-hidden="true"
          style={{ x: reduced ? 0 : glowX, y: reduced ? 0 : glowY }} />
        <motion.div className="lv-statement-glow lv-statement-glow-b" aria-hidden="true"
          style={{ x: reduced ? 0 : glowY, y: reduced ? 0 : glowX }} />
        <div className="lv-statement-copy">
          <motion.p className="lv-caption"
            initial={reduced ? false : { opacity: 0, y: 18 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.4 }}
            transition={{ duration: reduced ? 0 : 0.75, delay: reduced ? 0 : 0.05, ease: EASE }}>
            {closing ? 'From “what if” to “look at this”' : 'A local workspace for your next big idea'}
          </motion.p>
          <StatementHeadline
            reduced={reduced}
            lines={closing ? [['Make', 'something'], ['only', 'you', 'could', 'imagine.']] : [['Less', 'setup.'], ['More', 'making.']]}
          />
          <motion.p className="lv-statement-note"
            variants={STATEMENT_NOTE}
            initial={reduced ? false : 'hidden'}
            whileInView={reduced ? undefined : 'visible'}
            viewport={{ once: true, amount: 0.4 }}>
            {closing
              ? <>You bring the idea. Start shaping it in <span className="lv-statement-brand">FlutterForge.<motion.span
                className="lv-statement-brand-line" aria-hidden="true" variants={STATEMENT_RULE} /></span></>
              : 'Your brief, your source, your running app. Together.'}
          </motion.p>
        </div>
      </div>
      <motion.img className="lv-statement-photo lv-statement-photo-a" src={`${ASSETS}${closing ? 'ff-closing-tall' : 'ff-intro-tall'}.jpg`}
        width="250" height="350" alt={closing ? 'FlutterForge concept art: make it yours' : 'FlutterForge concept art: less setup, more making'} loading="lazy"
        initial={reduced ? false : { opacity: 0, scale: 0.94 }}
        whileInView={{ opacity: 1, scale: 1 }}
        viewport={{ once: true, amount: 0.25 }}
        transition={{ duration: reduced ? 0 : 1, ease: EASE }}
        style={{ y: reduced ? 0 : up, rotate: reduced ? 0 : tiltA }} />
      <motion.img className="lv-statement-photo lv-statement-photo-b" src={`${ASSETS}${closing ? 'ff-closing-wide' : 'ff-intro-wide'}.jpg`}
        width="350" height="250" alt={closing ? 'FlutterForge concept art: your next app' : 'FlutterForge concept art: prompt to preview'} loading="lazy"
        initial={reduced ? false : { opacity: 0, scale: 0.94 }}
        whileInView={{ opacity: 1, scale: 1 }}
        viewport={{ once: true, amount: 0.25 }}
        transition={{ duration: reduced ? 0 : 1, delay: reduced ? 0 : 0.12, ease: EASE }}
        style={{ y: reduced ? 0 : down, rotate: reduced ? 0 : tiltB }} />
    </div>
  );
}

function PhotoCollage({ kind }: { kind: 'story' | 'testimonials' }) {
  return (
    <div className="lv-collage" aria-hidden="true">
      {['Left', 'Right', 'Front'].map((position, index) => (
        <img key={position} className={`lv-collage-photo lv-collage-photo-${index + 1}`} src={`${ASSETS}ff-${kind}-${position.toLowerCase()}.jpg`}
          alt="" loading="lazy" width={index === 2 ? 290 : 235} height={index === 2 ? 200 : 300} />
      ))}
    </div>
  );
}

function FeaturePhone({ phone, index, reduced, progress }: {
  phone: typeof FEATURE_PHONES[number];
  index: number;
  reduced: boolean;
  progress: MotionValue<number>;
}) {
  // Reference: neighbouring columns drift in opposite directions as the row scrolls.
  const y = useTransform(progress, [0, 1], index % 2 === 0 ? [28, -28] : [-28, 28]);
  return (
    <Reveal className={`lv-phone-line-item lv-phone-line-item-${index + 1}`}>
      <motion.img src={`${ASSETS}${phone.image}.png`} width="496" height="1001" alt={phone.alt}
        loading="lazy" decoding="async" style={{ y: reduced ? 0 : y }} />
    </Reveal>
  );
}

function ScrollDetails({ reduced }: { reduced: boolean }) {
  const [active, setActive] = useState(0);
  return (
    <section id="lv-more" className="lv-more lv-container" aria-labelledby="lv-more-title">
      <Reveal><h2 id="lv-more-title" className="lv-shout">And there’s more</h2></Reveal>
      <div className="lv-details-layout">
        <div className="lv-detail-phones">
          {DETAILS.map((detail, index) => (
            <motion.article key={detail.image} className="lv-detail-step"
              onViewportEnter={() => setActive(index)} viewport={{ amount: 0.5 }}>
              <motion.img src={`${ASSETS}${detail.image}.png`} width="496" height="1001" alt={`${detail.label}: FlutterForge concept screen`}
                loading="lazy" initial={reduced ? false : { opacity: 0, x: -100 }} whileInView={{ opacity: 1, x: 0 }}
                viewport={{ amount: 0.3 }} transition={{ duration: reduced ? 0 : 0.85, ease: EASE }} />
              <div className="lv-detail-mobile-copy">
                <p className="lv-caption">{detail.label}</p><h3>{detail.title}</h3><p>{detail.body}</p>
              </div>
            </motion.article>
          ))}
        </div>
        <div className="lv-sticky-copy" aria-hidden="true">
          <div className="lv-detail-progress">{DETAILS.map((detail, index) => <span key={detail.image} className={active === index ? 'is-active' : ''} />)}</div>
          {DETAILS.map((detail, index) => (
            <div key={detail.image} className={`lv-detail-copy${active === index ? ' is-active' : ''}`}>
              <p className="lv-caption">{detail.label}</p><h3>{detail.title}</h3><p>{detail.body}</p>
            </div>
          ))}
          <ArrowDown className="lv-story-arrow" size={44} strokeWidth={1} />
        </div>
      </div>
    </section>
  );
}

function Plans({ signedIn }: { signedIn: boolean }) {
  const [yearly, setYearly] = useState(false);
  const format = (amount: number) => `₹${amount.toLocaleString('en-IN')}`;
  return (
    <section id="lv-pricing" className="lv-pricing lv-container" aria-labelledby="lv-pricing-title">
      <img src={`${ASSETS}ff-blob-pink.png`} className="lv-blob lv-pricing-blob" alt="" width="512" height="512" loading="lazy" />
      <Reveal className="lv-inset lv-pricing-head">
        <div><h2 id="lv-pricing-title">Room for your<br />next big thing.</h2><p>Start with an idea. Choose the space you need to build it.</p></div>
        <div className="lv-billing" role="group" aria-label="Billing period">
          <span className="lv-caption">Monthly or a yearly commitment <ArrowDown size={18} aria-hidden="true" /></span>
          <div className="lv-billing-switch">
            <button type="button" aria-pressed={!yearly} onClick={() => setYearly(false)}>Monthly</button>
            <button type="button" aria-pressed={yearly} onClick={() => setYearly(true)}>Yearly</button>
          </div>
        </div>
      </Reveal>
      <div className="lv-plan-grid lv-inset">
        {LANDING_PLANS.filter(plan => plan.id === 'free' || plan.id === 'pro').map(plan => (
          <Reveal key={plan.id}>
            <article className={`lv-plan${plan.id === 'pro' ? ' lv-metal' : ''}`} aria-label={`${plan.name} plan`}>
              <h3 className="lv-caption">{plan.name} plan</h3>
              <div className="lv-price" aria-live="polite"><strong>{plan.price === 0 ? 'Free' : format(yearly ? plan.yearlyPrice : plan.price)}</strong><span>{plan.price === 0 ? 'forever' : '/month'}</span></div>
              <p className="lv-price-period">{plan.price === 0 ? 'A place to start building.' : yearly ? `${format(plan.yearlyPrice * 12)} billed yearly` : 'Billed monthly'}</p>
              <Pill outline to={signedIn ? (plan.id === 'free' ? '/dashboard' : '/dashboard/billing') : plan.href}>{plan.buttonText}</Pill>
              <ul>{plan.features.map(feature => <li key={feature}><Check aria-hidden="true" size={19} /><span>{feature}</span></li>)}</ul>
            </article>
          </Reveal>
        ))}
      </div>
      <p className="lv-pricing-note lv-inset">Illustrative plan pricing. Checkout is currently in test mode—no real charges.</p>
    </section>
  );
}

export function LimeLandingPage() {
  const session = useAuthStore(state => state.session);
  const reduced = useReducedMotion() ?? false;
  const navigate = useNavigate();
  const [idea, setIdea] = useState('');
  const [ideaError, setIdeaError] = useState(false);
  const [tickerPaused, setTickerPaused] = useState(false);
  const ideaRef = useRef<HTMLInputElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const featuresRef = useRef<HTMLElement>(null);
  const { scrollYProgress: featuresProgress } = useScroll({ target: featuresRef, offset: ['start end', 'end start'] });
  const blobY = useTransform(featuresProgress, [0, 1], [42, -42]);
  const [showDock, setShowDock] = useState(false);
  const [activeSection, setActiveSection] = useState('');
  const workspace = session ? '/dashboard' : '/signup';
  const action = session ? 'Open studio' : 'Start building';

  useEffect(() => {
    const title = document.title;
    document.title = 'FlutterForge — Make something real';
    const anchor = window.location.hash.slice(1);
    if (anchor) document.getElementById(anchor)?.scrollIntoView();
    else window.scrollTo({ top: 0, behavior: 'instant' });
    return () => { document.title = title; };
  }, []);

  useEffect(() => {
    if (reduced) return;
    const lenis = new Lenis({ autoRaf: true, duration: 1.15, smoothWheel: true, anchors: { offset: -100 } });
    return () => lenis.destroy();
  }, [reduced]);

  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const observer = new IntersectionObserver(([entry]) => setShowDock(!entry.isIntersecting), { rootMargin: '100px 0px 0px 0px' });
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  // Highlight the section nearest the reading line as the dock travels with the page.
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const sections = ['lv-features', 'lv-pricing', 'lv-questions']
      .map((id) => document.getElementById(id))
      .filter((section): section is HTMLElement => Boolean(section));
    if (!sections.length) return;
    const ratios = new Map<string, number>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        ratios.set(entry.target.id, entry.isIntersecting ? entry.intersectionRatio : 0);
      }
      let nearest = '';
      let strongest = 0;
      for (const [id, ratio] of ratios) {
        if (ratio > strongest) {
          nearest = id;
          strongest = ratio;
        }
      }
      setActiveSection((current) => (current === nearest ? current : nearest));
    }, { rootMargin: '-24% 0px -52% 0px', threshold: [0, 0.05, 0.1, 0.2, 0.3] });
    for (const section of sections) observer.observe(section);
    return () => observer.disconnect();
  }, []);

  function submitIdea(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = idea.trim();
    if (!prompt) {
      setIdeaError(true);
      ideaRef.current?.focus();
      return;
    }
    try { sessionStorage.setItem(HERO_PROMPT_KEY, prompt); } catch { /* Navigation state still carries the idea when storage is blocked. */ }
    navigate(workspace, { state: { heroPrompt: prompt } });
  }

  return (
    <div className="lv-page" data-reduced-motion={reduced || undefined}>
      <a className="lv-skip" href="#lv-main">Skip to content</a>
      <header ref={headerRef} className="lv-header lv-container" id="lv-top">
        <nav aria-label="Landing navigation"><a href="#lv-features">Features</a><Link to="/agents">Agents</Link><a href="#lv-pricing">Plans</a><a href="#lv-questions">Questions</a><Link to={workspace} aria-label={action}><ArrowUpRight aria-hidden="true" /></Link></nav>
      </header>
      {showDock && (
        <nav className="lv-dock" aria-label="Quick navigation">
          <a href="#lv-top" className="lv-dock-brand" aria-label="Back to top"><Code2 size={23} aria-hidden="true" /></a>
          <a href="#lv-features" data-active={activeSection === 'lv-features' || undefined} aria-current={activeSection === 'lv-features' ? 'location' : undefined}>Features</a>
          <Link to="/agents">Agents</Link>
          <a href="#lv-pricing" data-active={activeSection === 'lv-pricing' || undefined} aria-current={activeSection === 'lv-pricing' ? 'location' : undefined}>Plans</a>
          <a href="#lv-questions" data-active={activeSection === 'lv-questions' || undefined} aria-current={activeSection === 'lv-questions' ? 'location' : undefined}>Questions</a>
          <Link className="lv-dock-cta" to={workspace}>Build <ArrowUpRight size={17} aria-hidden="true" /></Link>
        </nav>
      )}
      <main id="lv-main">
        <section className="lv-hero lv-container" aria-labelledby="lv-title">
          <h1 id="lv-title" className="lv-wordmark">FlutterForge</h1>
          <div className="lv-hero-layout">
            <div className="lv-hero-copy">
              <p>Your idea. A real Flutter app. Bring screens, source, and live previews together in one local workspace—then take the project with you.</p>
              <Pill to={workspace}>{action}</Pill>
              <p className="lv-concept-note">Original FlutterForge concept art · not a generated project</p>
            </div>
            <PhoneStage reduced={reduced} eager />
          </div>
          <img className="lv-blob lv-hero-blob" src={`${ASSETS}ff-blob-pink.png`} alt="" width="512" height="512" />
          <div className="lv-ticker-wrap">
            <div className="lv-ticker" aria-label="Build with Flutter and Dart for web, macOS, and Windows">
              <div className={`lv-ticker-track${tickerPaused ? ' is-paused' : ''}`} aria-hidden="true">
                {[0, 1].map(copy => <div className="lv-ticker-group" key={copy}>{TECHNOLOGIES.map(tech => <span key={tech}><Sparkles size={25} strokeWidth={1.5} />{tech}</span>)}</div>)}
              </div>
            </div>
            {!reduced && <button type="button" className="lv-ticker-toggle" onClick={() => setTickerPaused(value => !value)} aria-label={tickerPaused ? 'Play technology ticker' : 'Pause technology ticker'}>{tickerPaused ? <Play size={15} /> : <Pause size={15} />}</button>}
          </div>
        </section>

        <div className="lv-container"><Statement reduced={reduced} /></div>

        <section ref={featuresRef} id="lv-features" className="lv-features lv-container" aria-labelledby="lv-features-title">
          <h2 id="lv-features-title" className="lv-sr-only">The FlutterForge workspace</h2>
          <motion.img className="lv-blob lv-feature-blob" src={`${ASSETS}ff-blob-lime.png`} alt="" width="512" height="512"
            loading="lazy" style={{ y: reduced ? 0 : blobY, rotate: -47 }} />
          <div className="lv-feature-heading lv-inset">
            <LimeCarousel items={FEATURES} label="features" reducedMotion={reduced} />
            <Pill to={workspace}>{action}</Pill>
          </div>
          <div className="lv-phone-line" role="group" aria-label="FlutterForge concept screens">
            {FEATURE_PHONES.map((phone, index) => (
              <FeaturePhone key={phone.image} phone={phone} index={index} reduced={reduced} progress={featuresProgress} />
            ))}
          </div>
        </section>

        <section className="lv-story lv-container" aria-labelledby="lv-story-title">
          <Reveal className="lv-story-content lv-inset">
            <div><p className="lv-caption">Start with something you care about</p><h2 id="lv-story-title">Good ideas deserve<br />a first build.</h2><p>An admin dashboard. A booking flow. A tool your team wishes existed. Start with a clear brief, see the first version, and keep shaping it.</p><p>The best part? The source is right there. You can understand it, edit it, and take it in a completely new direction.</p><Link className="lv-text-link" to="/agents">Meet your building crew <ArrowUpRight size={22} aria-hidden="true" /></Link></div>
            <PhotoCollage kind="story" />
          </Reveal>
        </section>

        <ScrollDetails reduced={reduced} />
        <Plans signedIn={Boolean(session)} />

        <section id="lv-questions" className="lv-questions lv-container" aria-labelledby="lv-questions-title">
          <div className="lv-inset lv-questions-layout">
            <div><h2 id="lv-questions-title">A few things<br />worth knowing.</h2><LimeCarousel items={ANSWERS} label="answers" reducedMotion={reduced} /></div>
            <PhotoCollage kind="testimonials" />
          </div>
        </section>

        <div className="lv-container"><Statement closing reduced={reduced} /></div>

        <section className="lv-closing lv-container" aria-labelledby="lv-closing-title">
          <PhoneStage reduced={reduced} />
          <Reveal className="lv-closing-copy"><p className="lv-caption">A little less someday. A little more today.</p><h2 id="lv-closing-title">Your next app<br />starts here.</h2><p>Open the studio, describe your idea, and give it a first version. You can figure out the next chapter from there.</p><Pill to={workspace}>{action}</Pill><a className="lv-text-link" href="#lv-features">Explore the features <ArrowRight size={19} aria-hidden="true" /></a></Reveal>
          <img className="lv-blob lv-closing-blob" src={`${ASSETS}ff-blob-pink.png`} alt="" width="512" height="512" loading="lazy" />
        </section>
      </main>
      <footer className="lv-footer">
        <div className="lv-footer-wordmark" aria-hidden="true">FlutterForge</div>
        <div className="lv-container lv-footer-content">
          <div className="lv-footer-links">
            <div><h2>Studio</h2><Link to={workspace}>Start building</Link><Link to="/agents">AI agents</Link><a href="#lv-features">Features</a><a href="#lv-pricing">Plans</a></div>
            <div><h2>Explore</h2><a href="#lv-top">Home</a><a href="#lv-more">How it works</a><a href="#lv-questions">Questions</a><a href="https://github.com/codewithulavesh/flutterforge" target="_blank" rel="noreferrer">Source code <ArrowUpRight size={13} aria-hidden="true" /></a></div>
            <div><h2>Info</h2><Link to="/legal/terms">Terms of use</Link><Link to="/legal/privacy">Privacy notice</Link><Link to="/legal/permissions">Permissions</Link><Link to="/login">Sign in</Link></div>
          </div>
          <div className="lv-footer-build">
            <a className="lv-github" href="https://github.com/codewithulavesh/flutterforge" target="_blank" rel="noreferrer" aria-label="FlutterForge on GitHub"><Github size={27} /></a>
            <form onSubmit={submitIdea} aria-label="Start with an idea" noValidate>
              <label htmlFor="lv-idea">Your app idea</label>
              <div className="lv-idea-field"><input ref={ideaRef} id="lv-idea" value={idea} maxLength={2000} placeholder="An app I’ve always wanted…" aria-invalid={ideaError} aria-describedby={ideaError ? 'lv-idea-error' : 'lv-idea-hint'} onChange={event => { setIdea(event.target.value); setIdeaError(false); }} /><button type="submit">Make it real <ArrowUpRight size={19} aria-hidden="true" /></button></div>
              {ideaError ? <p id="lv-idea-error" role="alert">Describe the app you want to build.</p> : <p id="lv-idea-hint">We’ll bring your idea into the studio after you sign in.</p>}
            </form>
          </div>
        </div>
        <div className="lv-container lv-footer-bottom"><p>© {new Date().getFullYear()} FlutterForge</p><a href="https://bvbblz.framer.website/#features-1" target="_blank" rel="noreferrer">Layout reference: BVBBLZ <ArrowUpRight size={14} aria-hidden="true" /></a><a href="#lv-top" className="lv-back-top">Back to top <ArrowUp size={17} aria-hidden="true" /></a></div>
      </footer>
    </div>
  );
}
