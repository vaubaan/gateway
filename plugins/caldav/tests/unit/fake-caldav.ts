/**
 * A fake CalDAV server, in memory : the transport of the `caldav` tests.
 *
 * It answers the requests the plugin sends the way RFC 4791 / RFC 4918 /
 * RFC 6764 servers do — `PROPFIND` of the principal, the home and the
 * calendars, `REPORT calendar-query` with a time range, `GET`, conditional
 * `PUT` and `DELETE` with entity tags, `401` without the right Basic
 * credential, a `301` from `/.well-known/caldav` — and keeps every request.
 *
 * `handle` is the server itself ; `asFetch()` serves it as the `fetch` a test
 * hands the plugin, and `protocol.test.ts` serves the same handler over a real
 * HTTP socket. The shapes of the three server profiles (`icloudLike`,
 * `fastmailLike`, `nextcloudLike`) follow the servers' documented layouts —
 * a calendar home on another host, an address in the path, a `.well-known`
 * redirect to `/remote.php/dav` — they are not recordings of real answers.
 */

export interface FakeObject {
  ics: string;
  etag: string;
}

export interface FakeCalendar {
  /** Path of the collection, with its trailing `/`. */
  readonly path: string;
  readonly name: string;
  readonly description?: string;
  /** Components the calendar stores ; `['VEVENT']` by default. */
  readonly components?: readonly string[];
  /** Not a calendar at all (a plain collection) when false. */
  readonly isCalendar?: boolean;
  /** File name → object. */
  readonly objects: Map<string, FakeObject>;
}

export interface FakeServerOptions {
  /** `https://cal.example.com` */
  readonly origin: string;
  readonly username: string;
  readonly password: string;
  /** Where `/.well-known/caldav` redirects ; `null` : 404. */
  readonly wellKnown: string | null;
  /** The root `/` answers `current-user-principal` itself. */
  readonly rootAnswers: boolean;
  /** Path of the principal. */
  readonly principal: string;
  /** Absolute URL of the calendar home (it may be on another host). */
  readonly home: string;
  readonly addresses: readonly string[];
  readonly calendars: FakeCalendar[];
}

export interface FakeRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface FakeAnswer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const xmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const MULTISTATUS_OPEN =
  '<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">';

const ok200 = (href: string, props: string): string =>
  `<D:response><D:href>${xmlEscape(href)}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;

const multistatus = (responses: string): FakeAnswer => ({
  status: 207,
  headers: { 'content-type': 'application/xml; charset=utf-8' },
  body: `${MULTISTATUS_OPEN}${responses}</D:multistatus>`,
});

const answer = (status: number, headers: Record<string, string> = {}, body = ''): FakeAnswer => ({
  status,
  headers,
  body,
});

/** Start and end of the master event in ms (dates and floating times read as UTC) ; `null` when unreadable. */
function eventSpan(ics: string): { start: number; end: number; recurring: boolean } | null {
  const read = (name: string): number | null => {
    const m = new RegExp(`^${name}[^:\\r\\n]*:(\\d{8})(?:T(\\d{6})Z?)?`, 'm').exec(ics);
    if (!m) return null;
    const d = m[1]!;
    const t = m[2] ?? '000000';
    return Date.UTC(
      +d.slice(0, 4),
      +d.slice(4, 6) - 1,
      +d.slice(6, 8),
      +t.slice(0, 2),
      +t.slice(2, 4),
      +t.slice(4, 6),
    );
  };
  const start = read('DTSTART');
  if (start === null) return null;
  return { start, end: read('DTEND') ?? start + 3_600_000, recurring: /^RRULE:/m.test(ics) };
}

const utcOf = (v: string): number =>
  Date.UTC(
    +v.slice(0, 4),
    +v.slice(4, 6) - 1,
    +v.slice(6, 8),
    +v.slice(9, 11),
    +v.slice(11, 13),
    +v.slice(13, 15),
  );

export class FakeCaldavServer {
  readonly requests: FakeRequest[] = [];
  private etagCounter = 1;

  constructor(readonly options: FakeServerOptions) {}

  calendar(path: string): FakeCalendar | undefined {
    return this.options.calendars.find((c) => c.path === path);
  }

  /** Store an event directly, as another client would ; returns its etag. */
  put(calendarPath: string, name: string, ics: string): string {
    const etag = `"e${this.etagCounter++}"`;
    this.calendar(calendarPath)!.objects.set(name, { ics, etag });
    return etag;
  }

  handle(request: FakeRequest): FakeAnswer {
    this.requests.push(request);
    const url = new URL(request.url);
    const expected = `Basic ${Buffer.from(`${this.options.username}:${this.options.password}`).toString('base64')}`;
    if (request.headers.authorization !== expected) {
      return answer(401, { 'www-authenticate': 'Basic realm="fake"' });
    }
    const home = new URL(this.options.home);
    const onHomeHost = url.origin === home.origin;
    const path = url.pathname;

    if (request.method === 'PROPFIND') {
      if (path === '/.well-known/caldav') {
        return this.options.wellKnown === null
          ? answer(404)
          : answer(301, { location: this.options.wellKnown });
      }
      const asksPrincipal = request.body.includes('current-user-principal');
      if (
        asksPrincipal &&
        (path === this.options.principal ||
          path === this.options.wellKnown ||
          (path === '/' && this.options.rootAnswers))
      ) {
        return multistatus(
          ok200(
            path,
            `<D:current-user-principal><D:href>${this.options.principal}</D:href></D:current-user-principal>`,
          ),
        );
      }
      if (path === this.options.principal && request.body.includes('calendar-home-set')) {
        const addresses = this.options.addresses
          .map((a) => `<D:href>mailto:${a}</D:href>`)
          .join('');
        return multistatus(
          ok200(
            path,
            `<C:calendar-home-set><D:href>${this.options.home}</D:href></C:calendar-home-set>` +
              `<C:calendar-user-address-set>${addresses}<D:href>${this.options.principal}</D:href></C:calendar-user-address-set>` +
              '<D:displayname>Account</D:displayname>',
          ),
        );
      }
      if (onHomeHost && path === home.pathname && request.headers.depth === '1') {
        const children = this.options.calendars.map((c) => this.calendarResponse(c)).join('');
        return multistatus(
          ok200(path, '<D:resourcetype><D:collection/></D:resourcetype>') + children,
        );
      }
      const cal = this.calendar(path);
      if (onHomeHost && cal) return multistatus(this.calendarResponse(cal));
      return answer(404);
    }

    const cal = onHomeHost ? this.calendar(path) : undefined;
    if (request.method === 'REPORT' && cal) {
      const m = /start="(\d{8}T\d{6}Z)" end="(\d{8}T\d{6}Z)"/.exec(request.body);
      if (!m || request.headers.depth !== '1') return answer(400);
      const from = utcOf(m[1]!);
      const to = utcOf(m[2]!);
      const hits = [...cal.objects.entries()].filter(([, o]) => {
        const span = eventSpan(o.ics);
        if (span === null) return true;
        return span.start < to && (span.recurring || span.end > from);
      });
      return multistatus(
        hits
          .map(([name, o]) =>
            ok200(
              `${cal.path}${encodeURIComponent(name)}`,
              `<D:getetag>${xmlEscape(o.etag)}</D:getetag><C:calendar-data>${xmlEscape(o.ics)}</C:calendar-data>`,
            ),
          )
          .join(''),
      );
    }

    const slash = path.lastIndexOf('/');
    const parent = onHomeHost ? this.calendar(path.slice(0, slash + 1)) : undefined;
    const name = decodeURIComponent(path.slice(slash + 1));
    if (!parent || name.length === 0) return answer(404);
    const existing = parent.objects.get(name);
    const ifMatch = request.headers['if-match'];
    const ifNoneMatch = request.headers['if-none-match'];

    switch (request.method) {
      case 'GET':
        return existing
          ? answer(
              200,
              { 'content-type': 'text/calendar; charset=utf-8', etag: existing.etag },
              existing.ics,
            )
          : answer(404);
      case 'PUT': {
        if (ifNoneMatch === '*' && existing) return answer(412);
        if (ifMatch !== undefined && (!existing || existing.etag !== ifMatch)) return answer(412);
        if (!/^BEGIN:VCALENDAR\r\n/.test(request.body)) return answer(415);
        const etag = `"e${this.etagCounter++}"`;
        parent.objects.set(name, { ics: request.body, etag });
        return answer(existing ? 204 : 201, { etag });
      }
      case 'DELETE':
        if (!existing) return answer(404);
        if (ifMatch !== undefined && existing.etag !== ifMatch) return answer(412);
        parent.objects.delete(name);
        return answer(204);
      default:
        return answer(405);
    }
  }

  private calendarResponse(c: FakeCalendar): string {
    const type =
      c.isCalendar === false
        ? '<D:resourcetype><D:collection/></D:resourcetype>'
        : '<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>';
    const comps = (c.components ?? ['VEVENT']).map((n) => `<C:comp name="${n}"/>`).join('');
    return ok200(
      c.path,
      `${type}<D:displayname>${xmlEscape(c.name)}</D:displayname>` +
        (c.description
          ? `<C:calendar-description>${xmlEscape(c.description)}</C:calendar-description>`
          : '') +
        `<C:supported-calendar-component-set>${comps}</C:supported-calendar-component-set>`,
    );
  }

  /** The server as a `fetch`, for `ctx.fetch`. */
  asFetch(): typeof fetch {
    return async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      const result = this.handle({
        method: init?.method ?? 'GET',
        url:
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
        headers,
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return new Response(
        result.status === 204 || result.status === 301 || result.body === '' ? null : result.body,
        {
          status: result.status,
          headers: result.headers,
        },
      );
    };
  }
}

export const USER = 'ada@example.com';
export const PASSWORD = 'abcd-efgh-ijkl-mnop';

const calendars = (base: string): FakeCalendar[] => [
  { path: `${base}work/`, name: 'Work', description: 'Team meetings', objects: new Map() },
  { path: `${base}home/`, name: 'Home', objects: new Map() },
  { path: `${base}tasks/`, name: 'Tasks', components: ['VTODO'], objects: new Map() },
  { path: `${base}inbox/`, name: 'Inbox', isCalendar: false, objects: new Map() },
];

/** A plain server : the URL typed is the DAV root, which answers the principal. */
export function plainServer(origin = 'https://cal.example.com'): FakeCaldavServer {
  return new FakeCaldavServer({
    origin,
    username: USER,
    password: PASSWORD,
    wellKnown: '/dav/',
    rootAnswers: false,
    principal: '/dav/principals/ada/',
    home: `${origin}/dav/calendars/ada/`,
    addresses: [USER],
    calendars: calendars('/dav/calendars/ada/'),
  });
}

/** iCloud-like : the root answers, the home is on a sibling host (`p42-caldav.icloud.com`). */
export function icloudLike(): FakeCaldavServer {
  return new FakeCaldavServer({
    origin: 'https://caldav.icloud.com',
    username: USER,
    password: PASSWORD,
    wellKnown: null,
    rootAnswers: true,
    principal: '/123456789/principal/',
    home: 'https://p42-caldav.icloud.com/123456789/calendars/',
    addresses: [USER, 'ada@icloud.com'],
    calendars: [
      { path: '/123456789/calendars/home/', name: 'Home', objects: new Map() },
      {
        path: '/123456789/calendars/8F1C2B3A-4D5E-6F70-8192-A3B4C5D6E7F8/',
        name: 'Work',
        objects: new Map(),
      },
    ],
  });
}

/** Fastmail-like : `.well-known` redirect, the account address in the path, UUID calendars. */
export function fastmailLike(): FakeCaldavServer {
  return new FakeCaldavServer({
    origin: 'https://caldav.fastmail.com',
    username: USER,
    password: PASSWORD,
    wellKnown: '/dav/',
    rootAnswers: false,
    principal: `/dav/principals/user/${USER}/`,
    home: `https://caldav.fastmail.com/dav/calendars/user/${USER}/`,
    addresses: [USER],
    calendars: [
      { path: `/dav/calendars/user/${USER}/Default/`, name: 'Calendar', objects: new Map() },
      {
        path: `/dav/calendars/user/${USER}/b5c6d7e8-0000-4000-8000-000000000001/`,
        name: 'Work',
        objects: new Map(),
      },
    ],
  });
}

/** Nextcloud-like : `.well-known` redirects to `/remote.php/dav/`, and a calendar named with a space. */
export function nextcloudLike(): FakeCaldavServer {
  return new FakeCaldavServer({
    origin: 'https://cloud.example.org',
    username: 'ada',
    password: PASSWORD,
    wellKnown: '/remote.php/dav/',
    rootAnswers: false,
    principal: '/remote.php/dav/principals/users/ada/',
    home: 'https://cloud.example.org/remote.php/dav/calendars/ada/',
    addresses: ['ada@example.org'],
    calendars: [
      { path: '/remote.php/dav/calendars/ada/personal/', name: 'Personal', objects: new Map() },
      {
        path: '/remote.php/dav/calendars/ada/team%20plans/',
        name: 'Team plans',
        objects: new Map(),
      },
      {
        path: '/remote.php/dav/calendars/ada/contact_birthdays/',
        name: 'Birthdays',
        objects: new Map(),
      },
    ],
  });
}
