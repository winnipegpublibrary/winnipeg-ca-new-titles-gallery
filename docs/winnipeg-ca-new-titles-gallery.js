/**
 * WPL New Titles Gallery — shelf widget
 *
 * Reads from a static JSON file (produced on a schedule by a GitHub
 * Actions job, served via GitHub Pages) rather than a live backend.
 * GitHub Pages sends Access-Control-Allow-Origin: * on everything it
 * serves, so this uses a plain fetch() — no JSONP, no proxy, no CORS
 * workaround needed at all.
 *
 * IMPORTANT — capability change from the previous (GAS-backed) version:
 *   - Free-text search (data-list="search ...") is NOT supported. There's
 *     no live backend to run an arbitrary query against a static file.
 *   - data-only-month is NOT supported for the same reason — only the
 *     default (months=1) view, plus months=2 for graphicNovels/largeType
 *     specifically, are pre-computed by the Actions job. Both show a
 *     small "not available" message rather than silently guessing.
 *
 * Drop a container in your page:
 *   <div data-list="fiction"></div>
 * Add data-months="2" on the two shelves the Actions job pre-computes
 * that way (graphicNovels, largeType) to combine this month and last
 * month's titles. Any other value falls back to the default view.
 * Add data-height="242" to set cover height in px (default 180).
 * Add data-visible="5" to roughly size the shelf to show about that
 * many covers before scrolling is needed — approximate, since real
 * covers have varying width/height ratios unlike a fixed grid, based
 * on a typical book-cover proportion at the given height.
 * Add data-advance="single" to page one cover at a time (like
 * Springshare's native gallery) instead of the default "page" mode,
 * which advances by roughly one full visible screen's worth at once.
 * A min-height reserving the right amount of space is computed and
 * applied automatically — no need to set one by hand — unless an
 * inline min-height/height is already present on the div, which is
 * left alone.
 * Load this script after the container, or defer it.
 */
(function () {
  // Update this once the GitHub Pages site is live — something like
  // https://<org-or-user>.github.io/<repo>/data/new-titles.json
  const DATA_URL = 'PASTE_YOUR_GITHUB_PAGES_DATA_URL_HERE';
  const SYNDETICS_CLIENT = 'winnip';
  const DEFAULT_COVER_HEIGHT = 180;
  const GAP_PX = 12;
  // Rough width-to-height ratio for a typical trade paperback cover,
  // used only to estimate a "how wide should N covers roughly take
  // up" size for data-visible — real covers vary, so this is an
  // approximation, not an exact fit.
  const TYPICAL_COVER_ASPECT = 0.68;

  function coverUrl(isbn) {
    return 'https://secure.syndetics.com/index.aspx?isbn=' +
      isbn + '/MC.GIF&client=' + SYNDETICS_CLIENT;
  }

  // Bold, simple chevrons drawn as inline SVG rather than a Unicode
  // character or an icon font — gives control over stroke thickness
  // (matching a "nearly fills the circle" look) and doesn't depend
  // on any font being available on the host page.
  const CHEVRON_LEFT =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round" ' +
    'aria-hidden="true"><polyline points="15.9 4 6.9 12 15.9 20"></polyline></svg>';
  const CHEVRON_RIGHT =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round" ' +
    'aria-hidden="true"><polyline points="8.1 4 17.1 12 8.1 20"></polyline></svg>';

  function readOptions(container) {
    const heightPx = parseInt(container.getAttribute('data-height'), 10) || DEFAULT_COVER_HEIGHT;
    const visibleCount = parseInt(container.getAttribute('data-visible'), 10) || null;
    const advanceMode = container.getAttribute('data-advance') === 'single' ? 'single' : 'page';
    return { heightPx: heightPx, visibleCount: visibleCount, advanceMode: advanceMode };
  }

  // Reserves vertical space up front so the page doesn't jump once
  // real content (or even the skeleton) replaces whatever was there
  // before. Left alone if the page author already set an explicit
  // height/min-height inline, so a deliberate override isn't
  // clobbered.
  function applyReservedHeight(container, heightPx) {
    if (container.style.minHeight || container.style.height) return;
    container.style.minHeight = (heightPx + 33) + 'px';
  }

  // Approximate width for N covers at the given height, using a
  // typical cover's proportions — not exact, since real covers vary,
  // but close enough to roughly show "about this many" before
  // scrolling is needed.
  function applyVisibleWidth(track, heightPx, visibleCount) {
    if (!visibleCount || visibleCount < 1) return;
    const approxCoverWidth = heightPx * TYPICAL_COVER_ASPECT;
    const totalWidth = visibleCount * approxCoverWidth + (visibleCount - 1) * GAP_PX;
    track.style.maxWidth = Math.round(totalWidth) + 'px';
  }

  function buildShelf(container, items) {
    const opts = readOptions(container);
    applyReservedHeight(container, opts.heightPx);

    container.innerHTML = '';
    container.classList.add('nt-shelf-wrapper');
    container.style.setProperty('--nt-cover-height', opts.heightPx + 'px');

    const track = document.createElement('div');
    track.className = 'nt-shelf';
    applyVisibleWidth(track, opts.heightPx, opts.visibleCount);
    container.appendChild(track);

    items.forEach(function (item) {
      const a = document.createElement('a');
      a.href = item.link;
      a.className = 'nt-shelf-item';
      a.title = item.title;

      const img = new Image();
      img.alt = item.title;

      img.onload = function () {
        // Syndetics returns a ~1x1 placeholder GIF when it has no
        // cover for the ISBN — drop those slides rather than show
        // a blank/broken box.
        if (img.naturalWidth <= 1) {
          a.remove();
          return;
        }
        a.appendChild(img);
        track.appendChild(a);
        updateArrows(container, track);
      };
      img.onerror = function () {
        // leave it out entirely
      };
      img.src = coverUrl(item.isbn);
    });

    addArrows(container, track, opts.advanceMode);
  }

  // "page" mode advances by roughly one visible screen's worth of
  // covers at once (like a streaming service's horizontal title
  // row). "single" mode steps to the next/previous individual cover,
  // matching Springshare's native gallery behaviour. Covers have
  // varying width (real book covers aren't a fixed aspect ratio),
  // so "single" mode measures actual item positions in the DOM
  // rather than assuming a fixed width per step.
  function scrollByPage(track, direction, mode) {
    if (mode === 'single') {
      const items = Array.prototype.slice.call(track.querySelectorAll('.nt-shelf-item'));
      if (!items.length) return;
      const current = track.scrollLeft;
      const FUDGE = 2;

      if (direction > 0) {
        const nextItem = items.find(function (el) { return el.offsetLeft > current + FUDGE; });
        if (nextItem) track.scrollTo({ left: nextItem.offsetLeft, behavior: 'smooth' });
      } else {
        let target = items[0];
        for (let i = 0; i < items.length; i++) {
          if (items[i].offsetLeft < current - FUDGE) target = items[i];
          else break;
        }
        track.scrollTo({ left: target.offsetLeft, behavior: 'smooth' });
      }
      return;
    }

    track.scrollBy({ left: direction * track.clientWidth * 0.9, behavior: 'smooth' });
  }

  function updateArrows(container, track) {
    const prev = container.querySelector('.nt-shelf-arrow-prev');
    const next = container.querySelector('.nt-shelf-arrow-next');
    if (!prev || !next) return;

    const maxScroll = track.scrollWidth - track.clientWidth;
    const overflows = maxScroll > 1;

    const setState = function (button, hidden) {
      button.setAttribute('data-hidden', hidden ? 'true' : 'false');
      button.disabled = hidden;
    };

    if (!overflows) {
      setState(prev, true);
      setState(next, true);
      return;
    }

    setState(prev, track.scrollLeft <= 0);
    setState(next, track.scrollLeft >= maxScroll - 1);
  }

  function addArrows(container, track, advanceMode) {
    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'nt-shelf-arrow nt-shelf-arrow-prev';
    prev.setAttribute('aria-label', 'Scroll to previous titles');
    prev.innerHTML = CHEVRON_LEFT;
    prev.addEventListener('click', function () {
      scrollByPage(track, -1, advanceMode);
    });

    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'nt-shelf-arrow nt-shelf-arrow-next';
    next.setAttribute('aria-label', 'Scroll to next titles');
    next.innerHTML = CHEVRON_RIGHT;
    next.addEventListener('click', function () {
      scrollByPage(track, 1, advanceMode);
    });

    container.insertBefore(prev, track);
    container.appendChild(next);

    track.addEventListener('scroll', function () {
      updateArrows(container, track);
    });
    updateArrows(container, track);
  }

  const SKELETON_COUNT = 8;

  function renderSkeleton(container) {
    const opts = readOptions(container);
    applyReservedHeight(container, opts.heightPx);

    container.innerHTML = '';
    container.classList.add('nt-shelf-wrapper');
    container.style.setProperty('--nt-cover-height', opts.heightPx + 'px');

    const track = document.createElement('div');
    track.className = 'nt-shelf';
    applyVisibleWidth(track, opts.heightPx, opts.visibleCount);
    for (let i = 0; i < SKELETON_COUNT; i++) {
      const ph = document.createElement('div');
      ph.className = 'nt-skeleton-item';
      track.appendChild(ph);
    }
    const spinner = document.createElement('span');
    spinner.className = 'nt-spinner';
    spinner.setAttribute('role', 'status');
    spinner.setAttribute('aria-label', 'Loading new titles');
    track.appendChild(spinner);

    container.appendChild(track);
  }

  function showMessage(container, message) {
    container.innerHTML = '';
    container.classList.remove('nt-shelf-wrapper');
    const msg = document.createElement('div');
    msg.className = 'nt-shelf-message';
    msg.textContent = message;
    container.appendChild(msg);
  }

  // One shared fetch for the whole page, no matter how many gallery
  // boxes are on it — the promise is cached on window (same reasoning
  // as everything else shared this way: a classic <script> tag
  // re-executes this whole file every time it appears on the page,
  // so anything that needs to survive across multiple boxes/tags has
  // to live outside this file's own closure). Every box's init() just
  // awaits the same in-flight-or-resolved promise; the browser only
  // ever makes one request for the data file regardless of how many
  // shelves read from it or in what order they register.
  function getData() {
    if (!window.__ntGalleryDataPromise) {
      window.__ntGalleryDataPromise = fetch(DATA_URL, { cache: 'no-store' })
        .then(function (resp) {
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          return resp.json();
        });
    }
    return window.__ntGalleryDataPromise;
  }

  // Works out which key to look up in the fetched data's `lists`
  // object for a given box's data-* attributes, or flags that this
  // box is asking for something the static-file approach can't
  // provide at all (free-text search, or an isolated single month).
  function resolveSpec(container) {
    const list = container.getAttribute('data-list') || 'fiction';
    const onlyMonth = container.getAttribute('data-only-month');

    if (list.toLowerCase().indexOf('search ') === 0) {
      return { unsupported: 'Custom search galleries aren\u2019t available right now.' };
    }
    if (onlyMonth) {
      return { unsupported: 'This view isn\u2019t available right now.' };
    }

    const months = parseInt(container.getAttribute('data-months'), 10) || 1;
    if (months > 1) {
      // Only graphicNovels/largeType are pre-computed at months=2 by
      // the Actions job — anything else falls back to the plain key.
      return { key: list + ':' + months, fallbackKey: list };
    }
    return { key: list };
  }

  function applyFromData(container, data) {
    const spec = resolveSpec(container);
    if (spec.unsupported) {
      showMessage(container, spec.unsupported);
      return;
    }

    const lists = (data && data.lists) || {};
    const entry = lists[spec.key] || (spec.fallbackKey && lists[spec.fallbackKey]);

    if (!entry || !entry.items || !entry.items.length) {
      showMessage(container, 'No new titles available right now.');
      return;
    }
    buildShelf(container, entry.items);
  }

  function init(container) {
    renderSkeleton(container);
    getData()
      .then(function (data) {
        applyFromData(container, data);
      })
      .catch(function (err) {
        showMessage(container, 'Book gallery is temporarily unavailable.');
        console.error('Book gallery data fetch failed:', err);
      });
  }

  document.querySelectorAll('[data-list]').forEach(function (container) {
    // A second (or third...) script-tag inclusion on the same page
    // re-runs this whole file, and querySelectorAll matches every
    // matching div currently on the page — including ones an earlier
    // run already initialized. Without this guard, an already-loaded
    // shelf gets init() called on it again, stacking duplicate
    // covers instead of cleanly replacing them.
    if (container.dataset.ntInitialized) return;
    container.dataset.ntInitialized = 'true';
    init(container);
  });
})();
