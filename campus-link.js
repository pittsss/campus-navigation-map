// Campus switch + directions between the two campuses, using Google Maps (no API key needed).
(function () {
    const CAMPUSES = {
        main: {
            name: 'Main campus',
            subtitle: 'Batanes State College · Main Building',
            pos: { lat: 20.450983751626257, lng: 121.96859583684216 },
        },
        agri: {
            name: 'BSC Agricultural Laboratory',
            subtitle: 'BSC · Agricultural Laboratory',
            pos: { lat: 20.454265489133476, lng: 121.97410688505313 },
        },
    };
    const site = new URLSearchParams(location.search).get('site') === 'agri' ? 'agri' : 'main';
    const here = CAMPUSES[site];
    const there = CAMPUSES[site === 'agri' ? 'main' : 'agri'];

    const ll = p => `${p.lat},${p.lng}`;
    const $ = id => document.getElementById(id);

    // Page header + campus switch
    $('siteSubtitle').textContent = here.subtitle;
    if (site === 'agri') document.title = 'Agricultural Laboratory - BSC Campus Navigator';
    document.querySelectorAll('.site-switch a').forEach(a => {
        const on = a.dataset.site === site;
        a.classList.toggle('on', on);
        if (on) a.setAttribute('aria-current', 'page');
    });

    // Straight-line distance, just for the "about … away" hint (the road route is a bit longer).
    function distanceKm(a, b) {
        const R = 6371, rad = Math.PI / 180;
        const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(h));
    }

    // Opens Google Maps (the app on phones) with the route ready to start.
    // Without an origin, Google Maps starts from the user's current location.
    function directionsUrl(mode, from) {
        const q = new URLSearchParams({ api: '1', destination: ll(there.pos), travelmode: mode });
        if (from) q.set('origin', ll(from));
        return `https://www.google.com/maps/dir/?${q}`;
    }

    // Small route preview embedded in the page.
    function embedUrl(mode) {
        const q = new URLSearchParams({ saddr: ll(here.pos), daddr: ll(there.pos), dirflg: mode === 'walking' ? 'w' : 'd', output: 'embed' });
        return `https://maps.google.com/maps?${q}`;
    }

    function setMode(mode) {
        document.querySelectorAll('.campus2 .mode-switch button').forEach(b => {
            const on = b.dataset.mode === mode;
            b.classList.toggle('on', on);
            b.setAttribute('aria-pressed', on);
        });
        $('campus2FromMain').href = directionsUrl(mode, here.pos);
        $('campus2FromHere').href = directionsUrl(mode, null);
        $('campus2Map').src = embedUrl(mode);
    }

    document.querySelectorAll('.campus2 .mode-switch button').forEach(b =>
        b.addEventListener('click', () => setMode(b.dataset.mode)));

    $('campus2Title').textContent = there.name;
    $('campus2Map').title = `Route from the ${here.name === 'Main campus' ? 'main campus' : here.name} to the ${there.name === 'Main campus' ? 'main campus' : there.name}`;
    $('campus2FromMain').textContent = site === 'agri' ? 'From the Agri Lab' : 'From main campus';
    $('campus2Meta').textContent = `About ${distanceKm(here.pos, there.pos).toFixed(1)} km from here`;
    setMode('walking');
})();
