/* Blind by Glamour — scroll-scrubbed hero landing.
   IIFE: phase constants, header/product enter-exit helpers, rAF scrub loop.

   Hero video loading note:
   Scroll scrubbing assigns video.currentTime continuously. That only works
   when the browser can seek the file. The static host used for sharing does
   not answer HTTP Range requests (it returns a plain 200), so a direct
   <video src> is effectively unseekable there and the scrub appears frozen.
   Fix: fetch the whole clip once and hand the <video> a Blob URL — blobs are
   fully seekable locally, no Range needed. Falls back to the plain source if
   the fetch fails (file://, offline, old browser). */
(() => {
  'use strict';

  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---- Phase constants ---- */
  const A_END = 0.18;
  const B_END = 0.88;
  const HEADER_A_END = A_END * 0.7;            /* ~0.126 */
  const PRODUCT_ENTER = [A_END, A_END + 0.18]; /* [0.18, 0.36] */
  const SCALE_WINDOW = [A_END + 0.18, B_END];  /* [0.36, 0.88] */

  /* ---- Scrub tuning ---- */
  const K = 0.1;
  const DEADBAND = 0.02;
  const SEEK_INTERVAL = 30; /* ms between seeks */

  /* ---- Math ---- */
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const remap = (p, a, b) => clamp01((p - a) / (b - a));
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  const lerp = (a, b, t) => a + (b - a) * t;

  /* prefers-reduced-motion: linear remap, no blur */
  const ease = REDUCED ? (t) => t : easeOutCubic;
  const blurPx = (v) => (REDUCED ? 0 : v);

  /* ---- Elements ---- */
  const $ = (sel) => document.querySelector(sel);
  const hero = $('.hero');
  const heroTitle = $('.hero-title');
  const cta = $('.cta');
  const shopNow = $('.shop-now');
  const product = $('.product');
  const addBtn = $('.add-btn');
  const brandVideo = $('.brand');
  const heroVideo = $('.hero-bg-video');
  const menuWordA = $('.menu-word__a');
  const menuWordB = $('.menu-word__b');
  const tagline = $('.tagline-hero');
  const secondary = Array.from(document.querySelectorAll('.menu-secondary'));

  /* Header exit stack — bottom-up, windows as fractions of headerP */
  const headerExits = [
    { el: tagline,      start: 0.0,  end: 0.45 }, /* Tagline */
    { el: secondary[3], start: 0.08, end: 0.53 }, /* ABOUT US */
    { el: secondary[2], start: 0.16, end: 0.61 }, /* EVENTS */
    { el: secondary[1], start: 0.24, end: 0.69 }, /* SERVICES */
    { el: secondary[0], start: 0.32, end: 0.77 }, /* BRANDS */
    { el: menuWordA,    start: 0.4,  end: 0.85 }, /* SHOP */
  ];
  const MENU_ENTER = [0.9, 1.0];

  /* ---- Motion helpers ---- */

  /* Hero title/CTA exit: opacity 1→0, translateY 0→-32px, blur 0→12px */
  const heroExit = (el, p) => {
    const e = ease(p);
    el.style.opacity = String(1 - e);
    el.style.transform = `translateY(${-32 * e}px)`;
    el.style.filter = `blur(${blurPx(12 * e)}px)`;
  };

  /* Pattern P5 reverse: opacity 1→0, translateY 0→-12px, blur 0→8px */
  const exitLiftFade = (el, p) => {
    const e = ease(p);
    el.style.opacity = String(1 - e);
    el.style.transform = `translateY(${-12 * e}px)`;
    el.style.filter = `blur(${blurPx(8 * e)}px)`;
  };

  /* MENU enter: opacity 0→1, translateY +6px→0, blur 6px→0 */
  const enterMenu = (el, p) => {
    const e = ease(p);
    el.style.opacity = String(e);
    el.style.transform = `translateY(${6 * (1 - e)}px)`;
    el.style.filter = `blur(${blurPx(6 * (1 - e))}px)`;
  };

  /* Product/add enter: opacity 0→1, blur 12px→0 */
  const enterFade = (el, p) => {
    const e = ease(p);
    el.style.opacity = String(e);
    el.style.filter = `blur(${blurPx(12 * (1 - e))}px)`;
  };

  /* ---- Scrub state ---- */
  let scrubCurrent = 0;
  let lastSeek = 0;
  let seeking = false;
  let duration = 0;

  const initScrub = () => {
    duration = heroVideo.duration || 0;
    heroVideo.pause();
    try {
      heroVideo.currentTime = 0.001;
    } catch (err) { /* ignore */ }
    scrubCurrent = 0.001;
  };

  /* Brand logo video plays on boot */
  if (brandVideo) brandVideo.play().catch(() => {});

  /* ---- Hero source ----
     Two cuts ship with the page: a 16:9 master for landscape/desktop and a
     9:16 portrait cut for phones. Picking by orientation rather than width
     keeps the framing right when a tablet is rotated, and means the hero
     never crops a close-up face down to a strip.

     Each cut is fetched once and handed to the <video> as a Blob URL:
     static hosts that ignore HTTP Range would otherwise make the file
     unseekable and freeze the scrub. */
  const portraitQuery = window.matchMedia('(orientation: portrait)');
  const compactQuery = window.matchMedia('(max-width: 640px)');

  const pickHero = () => {
    const portrait = portraitQuery.matches;
    return {
      src: portrait ? heroVideo.dataset.srcPortrait : heroVideo.dataset.srcLandscape,
      poster: portrait ? heroVideo.dataset.posterPortrait : heroVideo.dataset.posterLandscape,
    };
  };

  let blobUrl = null;
  let activeSrc = '';

  const waitForMetadata = () => new Promise((resolve) => {
    if (heroVideo.readyState >= 1 && heroVideo.duration) { resolve(); return; }
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    heroVideo.addEventListener('loadedmetadata', finish, { once: true });
    heroVideo.addEventListener('error', finish, { once: true });
    setTimeout(finish, 8000); /* never hang the page */
  });

  const swapToBlob = async (src) => {
    if (!heroVideo || !src) return;

    /* No fetch/Blob support (or file://): just point at the plain file. */
    if (typeof fetch !== 'function' || typeof Blob !== 'function') {
      heroVideo.src = src;
      heroVideo.load();
      return;
    }

    try {
      const res = await fetch(src, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('http');
      const blob = await res.blob();
      if (!blob || blob.size < 1024) throw new Error('empty');
      const nextUrl = URL.createObjectURL(blob);
      const previous = blobUrl;
      blobUrl = nextUrl;
      heroVideo.src = nextUrl;
      heroVideo.load();
      /* Release the previous cut only after the new one owns the element. */
      if (previous) { try { URL.revokeObjectURL(previous); } catch (e) {} }
    } catch (err) {
      heroVideo.src = src;
      heroVideo.load();
    }
  };

  const prepareHero = async (force) => {
    if (!heroVideo) return;
    const { src, poster } = pickHero();
    if (!force && src === activeSrc) return;
    activeSrc = src;
    duration = 0;
    scrubCurrent = 0;
    seeking = false;
    if (poster) heroVideo.poster = poster;
    await swapToBlob(src);
    await waitForMetadata();
    initScrub();
  };

  prepareHero(false);

  /* Rotating a phone switches cuts; debounce so the resize storm of an
     orientation change only costs one reload. */
  let orientationTimer = null;
  const onOrientationChange = () => {
    clearTimeout(orientationTimer);
    orientationTimer = setTimeout(() => { prepareHero(true); }, 320);
  };

  if (portraitQuery.addEventListener) {
    portraitQuery.addEventListener('change', onOrientationChange);
  }
  window.addEventListener('orientationchange', onOrientationChange);

  heroVideo.addEventListener('seeked', () => { seeking = false; });
  heroVideo.addEventListener('error', () => { seeking = false; });

  /* iOS Safari refuses programmatic currentTime seeking until the media
     element has been "unlocked" by a user gesture. A muted play/pause
     cycle on the first touch does exactly that, and keeps the scrub
     responsive on iPhone. Desktop is unaffected. */
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  const unlockMedia = () => {
    if (!heroVideo) return;
    try {
      const p = heroVideo.play();
      if (p && typeof p.then === 'function') {
        p.then(() => { try { heroVideo.pause(); } catch (e) {} })
         .catch(() => {});
      } else {
        heroVideo.pause();
      }
    } catch (e) { /* ignore */ }
  };

  if (isIOS) {
    ['touchstart', 'pointerdown', 'click'].forEach((ev) => {
      document.addEventListener(ev, unlockMedia, { once: true, passive: true });
    });
  }

  /* ---- Add button horizontal position: product right edge + 1 root em ----
     On phones the card spans the full width, so there is no room to the
     right of it — CSS anchors the button to the bottom-right corner instead
     and the inline offset has to be cleared. */
  let rootFs = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const positionAddBtn = () => {
    if (!product || !addBtn) return;
    if (compactQuery.matches) {
      addBtn.style.left = '';
      return;
    }
    const rect = product.getBoundingClientRect();
    addBtn.style.left = `${rect.right + rootFs}px`;
  };

  /* ---- Resize: debounce 120ms, remeasure ---- */
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      rootFs = parseFloat(getComputedStyle(document.documentElement).fontSize);
      positionAddBtn();
    }, 120);
  });

  let titleCtaHidden = false;

  /* ---- Main rAF loop ---- */
  const frame = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const p = clamp01(max > 0 ? window.scrollY / max : 0);

    /* Phase A — hero rise: margin-top 30vh → 0 (24vh on phones) */
    const a = ease(remap(p, 0, A_END));
    const riseStart = compactQuery.matches ? 0.24 : 0.3;
    if (hero) hero.style.marginTop = `${lerp(riseStart * window.innerHeight, 0, a)}px`;

    /* Hero title + CTA exit (same motion) */
    const t = ease(remap(p, 0, A_END));
    if (heroTitle) heroExit(heroTitle, t);
    if (cta) heroExit(cta, t);
    if (a > 0.98 && !titleCtaHidden) {
      titleCtaHidden = true;
      if (heroTitle) heroTitle.style.pointerEvents = 'none';
      if (cta) cta.style.pointerEvents = 'none';
      if (shopNow) shopNow.style.pointerEvents = 'none';
    }

    /* Header exits — windows as fractions of headerP */
    const headerP = remap(p, 0, HEADER_A_END);
    for (let i = 0; i < headerExits.length; i++) {
      if (headerExits[i].el) exitLiftFade(headerExits[i].el, remap(headerP, headerExits[i].start, headerExits[i].end));
    }
    if (menuWordB) enterMenu(menuWordB, remap(headerP, MENU_ENTER[0], MENU_ENTER[1]));

    /* Product + add button enter */
    const pe = ease(remap(p, PRODUCT_ENTER[0], PRODUCT_ENTER[1]));
    if (product) enterFade(product, pe);
    if (addBtn) enterFade(addBtn, pe);
    if (pe >= 0.02 && addBtn) addBtn.style.pointerEvents = 'auto';

    /* Product thumb scale 1× → 1.9×  (tighter on phones: the card is full-width) */
    const scaleP = ease(remap(p, SCALE_WINDOW[0], SCALE_WINDOW[1]));
    const maxScale = compactQuery.matches ? 1.45 : 1.9;
    document.documentElement.style.setProperty('--card-scale', String(1 + (maxScale - 1) * scaleP));

    positionAddBtn();

    /* Phase B — hero video scrub (p 0 → 0.88) */
    if (duration > 0) {
      const target = remap(p, 0, B_END) * duration;
      scrubCurrent += (target - scrubCurrent) * K;
      const now = performance.now();
      if (!seeking && Math.abs(target - scrubCurrent) > DEADBAND && now - lastSeek >= SEEK_INTERVAL) {
        seeking = true;
        try { heroVideo.currentTime = scrubCurrent; } catch (e) { seeking = false; }
        lastSeek = now;
      }
    }

    requestAnimationFrame(frame);
  };

  positionAddBtn();
  requestAnimationFrame(frame);
})();
