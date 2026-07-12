import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { isAuthed, unauthorized } from "../../shared/auth.mts";

// Most Twilio line-type lookups per search that we'll PAY for (new numbers only —
// cached numbers are free). Bounds the cost of any single search.
const MAX_NEW_LOOKUPS = 80;

// ---- Types ----
interface Lead {
  name: string;
  address: string;
  phone: string;
  phoneRaw: string;
  phoneE164: string | null;
  lineType: "mobile" | "landline" | "voip" | "unknown" | null;
  carrierName: string | null;
  website: string | null;
  rating: number;
  reviews: number;
  oldestReviewYearsAgo: number | null;
  lastReviewDaysAgo: number | null;
  maturity: "Established" | "Growing" | "Newer";
  maturityNote: string;
  ownerName: string | null;
  ownerSource: string | null;
  ownerConfidence: "high" | "medium" | "low" | null;
  websiteFlag: "none" | "weak" | "ok" | "unknown";
  score: number;
  scoreReasons: string[];
  mapsUrl: string;
  marketScore: number;
  marketLabel: string;
  marketReason: string;
}

const PLACES_SEARCH = "https://places.googleapis.com/v1/places:searchText";

// Fields we ask Google for. Keeping this tight controls cost.
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "places.websiteUri",
  "places.rating",
  "places.userRatingCount",
  "places.googleMapsUri",
  "places.reviews",
  "places.businessStatus",
  "places.location",
].join(",");

function daysBetween(thenMs: number, nowMs: number): number {
  return Math.round((nowMs - thenMs) / (1000 * 60 * 60 * 24));
}

// Median of a list (robust to a few far-away outliers, unlike an average).
function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Great-circle distance between two lat/lng points, in meters.
function distMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000, toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// How far out to keep businesses from the searched city's center. ~25 km keeps
// immediately adjacent towns (in DFW: Frisco/McKinney/Allen/Little Elm/Celina)
// but drops far ones (Carrollton/Lewisville/Denton/downtown Dallas).
const NEAR_RADIUS_M = 25000;

// Find the searched city's center point (e.g. "Prosper TX") using the Places API
// (already enabled) — the top result for a bare city query sits in/at that city,
// so the near radius is measured from the city itself. Returns null on failure
// (caller falls back to the median of the result locations).
async function cityCenter(apiKey: string, text: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const res = await fetch(PLACES_SEARCH, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "places.location" },
      body: JSON.stringify({ textQuery: text, pageSize: 1, languageCode: "en", regionCode: "US" }),
    });
    if (!res.ok) return null;
    const d = await res.json();
    const loc = d.places?.[0]?.location;
    if (loc && typeof loc.latitude === "number") return { lat: loc.latitude, lng: loc.longitude };
    return null;
  } catch { return null; }
}

// Run async work over a list with bounded concurrency (keeps us under API limits
// and predictable on time).
async function pool<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = await Promise.all(items.slice(i, i + size).map(fn));
    for (const r of batch) out.push(r);
  }
  return out;
}

// One Text Search restricted to a rectangle (used to tile a metro for deep search).
async function tileSearch(apiKey: string, textQuery: string, rectangle: any, maxPages: number): Promise<any[]> {
  const out: any[] = [];
  let pageToken = "";
  for (let page = 0; page < maxPages; page++) {
    const reqBody: any = { textQuery, pageSize: 20, languageCode: "en", regionCode: "US", locationRestriction: { rectangle } };
    if (pageToken) reqBody.pageToken = pageToken;
    try {
      const res = await fetch(PLACES_SEARCH, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": FIELD_MASK + ",nextPageToken" },
        body: JSON.stringify(reqBody),
      });
      if (!res.ok) break;
      const data = await res.json();
      for (const p of (data.places ?? [])) out.push(p);
      pageToken = data.nextPageToken || "";
      if (!pageToken) break;
    } catch { break; }
  }
  return out;
}

// Build an E.164 number (+1XXXXXXXXXX) for the Twilio lookup. Prefers Google's
// international number, which is already nearly E.164. Returns null if unusable.
function toE164(national: string, intl: string): string | null {
  const raw = (intl || national || "").replace(/[^\d+]/g, "");
  if (!raw) return null;
  if (raw.startsWith("+")) return raw;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  if (digits.length === 10) return "+1" + digits;
  return digits.length >= 8 ? "+" + digits : null;
}

// Ask Twilio whether a number is a mobile, landline, or VoIP line. A mobile is
// the best lead (direct shot at the owner). Best-effort + time-limited; returns
// null on any failure so a slow/failed lookup never breaks the search.
async function lookupLineType(
  e164: string,
  sid: string,
  token: string
): Promise<{ type: Lead["lineType"]; carrier: string | null } | null> {
  try {
    const url = `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(e164)}?Fields=line_type_intelligence`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Authorization: "Basic " + btoa(`${sid}:${token}`) },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    const lti = data.line_type_intelligence;
    if (!lti || !lti.type) return null;
    const t = String(lti.type).toLowerCase();
    let type: Lead["lineType"] = "unknown";
    if (t === "mobile") type = "mobile";
    else if (t.includes("voip")) type = "voip";
    else if (t === "landline" || t === "tollfree" || t === "premium" || t === "shared_cost" || t === "uan") type = "landline";
    return { type, carrier: lti.carrier_name ?? null };
  } catch {
    return null;
  }
}

// Try to pull an owner's first name from an owner's reply to a review.
// Owners often sign replies: "Thanks! - Mike" or "- Mike, Owner".
// Only returns a name when the evidence is reasonably clear (we never guess).
const NOT_NAMES = new Set([
  "the", "team", "owner", "manager", "thanks", "thank", "regards", "best",
  "staff", "management", "customer", "service", "your", "our", "we", "us",
  "google", "review", "company", "llc", "inc", "co", "and", "for", "you",
]);

function extractOwnerFromReviews(reviews: any[]): { name: string; source: string } | null {
  if (!Array.isArray(reviews)) return null;
  for (const r of reviews) {
    // The owner's reply lives in different shapes depending on API version.
    const reply: string =
      (r.reply?.text ?? r.ownerResponse?.text ?? r.authorReply?.text ?? "")
        .toString();
    if (!reply) continue;

    // Look for a sign-off name: "- Mike", "— Sarah", "- John, Owner", "-Tom"
    const m = reply.match(/[-\u2013\u2014]\s*([A-Z][a-z]{1,15})(?:[\s,]|$)/);
    if (m) {
      const candidate = m[1].trim();
      if (!NOT_NAMES.has(candidate.toLowerCase()) && candidate.length >= 2) {
        return { name: candidate, source: "review reply" };
      }
    }
    // Also catch "This is Mike, the owner" style phrasing.
    const m2 = reply.match(/(?:I'?m|this is|owner[, ]+)\s+([A-Z][a-z]{1,15})\b/i);
    if (m2) {
      const candidate = m2[1].trim();
      if (!NOT_NAMES.has(candidate.toLowerCase()) && candidate.length >= 2) {
        return { name: candidate, source: "review reply" };
      }
    }
  }
  return null;
}

// Capitalized words that look like names but aren't. Combined with the
// "must appear in 2+ reviews" rule, this keeps false positives very low.
const NAME_STOPWORDS = new Set([
  "the","they","them","their","this","that","these","those","there","then",
  "we","our","us","it","he","she","his","her","him","you","your","my","me",
  "and","but","or","so","if","when","what","why","how","who","which",
  "highly","very","great","good","best","amazing","excellent","awesome","nice",
  "would","will","was","were","is","are","had","have","has","did","does","do",
  "thank","thanks","thankyou","recommend","recommended","service","services",
  "company","team","crew","staff","owner","business","work","works","job","done",
  "quality","price","prices","time","times","day","days","week","weeks","year","years",
  "monday","tuesday","wednesday","thursday","friday","saturday","sunday","today",
  "january","february","march","april","may","june","july","august",
  "september","october","november","december","summer","winter","spring","fall",
  "google","yelp","facebook","texas","north","south","east","west",
  "mr","mrs","ms","dr","sir","maam",
  "guys","guy","gentleman","man","men","lady","folks","people","everyone","everybody",
  "definitely","absolutely","professional","professionalism","quick","quickly",
  "super","really","truly","fast","friendly","honest","fair","reasonable",
  "they're","i've","i'll","we've","they've","overall","again","also","plus",
  "here","home","house","place","area","city","town","family","friend","friends",
  // sentence-starters / connectors that get capitalized mid-review
  "from","after","before","once","while","since","because","though","although",
  "however","finally","recently","initially","unfortunately","fortunately",
  "honestly","basically","literally","simply","currently","previously",
  "eventually","immediately","throughout","anyway","anyways","yes","no","not",
  "just","even","still","such","both","each","all","now","when","then","start",
  "end","to","as","at","on","in","of","by","up","out","over","into","about",
  "with","within","around","wow","ok","okay","perfect","fantastic","wonderful",
  "outstanding","exceptional","incredible","beautiful","totally","completely",
  "extremely","everything","nothing","something","anything","needless","being",
  "getting","having","doing","looking","coming","going","calling","contacting",
  // home-services / roofing review vocabulary
  "roof","roofs","roofing","storm","hail","weather","rain","wind","damage",
  "insurance","claim","claims","warranty","estimate","estimates","quote","quotes",
  "pricing","price","cost","scheduling","schedule","scheduled","timing",
  "communication","response","responsive","install","installation","installed",
  "repair","repairs","replacement","replaced","completion","completed","finished",
  "cleanup","workmanship","materials","shingles","gutters","project","projects",
  "process","experience","contractor","contractors","crew","customer","customers",
]);

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// THE KEY SIGNAL: a first name customers mention again and again in their
// reviews is almost always the owner/operator. We only count a name when it
// shows up in a clearly personal context ("Mike was great", "ask for Mike",
// "Mike and his crew"), and we tally how many SEPARATE reviews mention it.
// Returns the top name plus the evidence so the caller can set confidence.
function extractOwnerFromReviewText(
  reviews: any[],
  businessName: string
): { name: string; hits: number; total: number; ambiguous: boolean; runnerUp: string | null } | null {
  if (!Array.isArray(reviews) || !reviews.length) return null;

  // Don't mistake words from the business's own name for a person.
  const bizTokens = new Set(
    (businessName || "").toLowerCase().split(/[^a-z]+/).filter(Boolean)
  );

  const NAME = "([A-Za-z][a-z]{1,14})";
  const patterns = [
    new RegExp(`\\b${NAME}\\s+(?:and his|and her|& his|& her|and the team|and his team|and her team)\\b`, "g"),
    new RegExp(`\\b${NAME}\\s+(?:was|is|did|does|came|come|showed|arrived|installed|fixed|repaired|replaced|quoted|explained|helped|handled|walked|took|gave|made|went)\\b`, "g"),
    new RegExp(`\\b(?:ask for|asked for|thanks to|thank you|shout out to|shoutout to|kudos to|recommend|call|see)\\s+${NAME}\\b`, "gi"),
    new RegExp(`\\b${NAME}'s\\s+(?:team|crew|company|guys|work|service)\\b`, "g"),
    new RegExp(`\\b${NAME},?\\s+(?:the\\s+)?owner\\b`, "gi"),
  ];

  const tally = new Map<string, number>();
  let total = 0;

  for (const r of reviews) {
    const text: string = (r.text?.text ?? r.originalText?.text ?? "").toString();
    if (!text.trim()) continue;
    total++;

    // The reviewer's own first name shouldn't count as the owner ("I'm Mike...").
    const reviewerFirst = ((r.authorAttribution?.displayName ?? "").toString().trim().split(/\s+/)[0] || "").toLowerCase();

    const foundThisReview = new Set<string>();
    for (const re of patterns) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const raw = (m[1] || "").trim();
        if (raw.length < 2) continue;
        // Real names are capitalized; this rejects lowercase common words
        // ("roof was…") that the case-insensitive trigger patterns can catch.
        if (raw[0] < "A" || raw[0] > "Z") continue;
        const low = raw.toLowerCase();
        if (NAME_STOPWORDS.has(low)) continue;
        if (bizTokens.has(low)) continue;
        if (low === reviewerFirst) continue;
        foundThisReview.add(titleCase(raw));
      }
    }
    for (const nm of foundThisReview) tally.set(nm, (tally.get(nm) ?? 0) + 1);
  }

  if (!tally.size) return null;
  const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  const [topName, topHits] = sorted[0];
  const runner = sorted[1] ?? null;
  // "Ambiguous" = a second name appears just as often — we genuinely can't tell.
  const ambiguous = !!runner && runner[1] === topHits;

  return { name: topName, hits: topHits, total, ambiguous, runnerUp: runner ? runner[0] : null };
}

// Fetch a business website and try to find an owner name on it.
// Best-effort, time-limited; returns null on any failure or weak evidence.
async function extractOwnerFromWebsite(url: string): Promise<{ name: string; source: string } | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (LeadFinder)" },
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    let html = await res.text();
    html = html.replace(/<script[\s\S]*?<\/script>/gi, " ")
               .replace(/<style[\s\S]*?<\/style>/gi, " ")
               .replace(/<[^>]+>/g, " ")
               .replace(/\s+/g, " ")
               .slice(0, 40000);

    const patterns = [
      /(?:owner|founder|owned by|founded by|proprietor)[:\s,]+([A-Z][a-z]{1,15}(?:\s+[A-Z][a-z]{1,15})?)/,
      /([A-Z][a-z]{1,15}(?:\s+[A-Z][a-z]{1,15})?),?\s+(?:owner|founder|proprietor)\b/,
      /(?:meet|i'?m|my name is|hi,?\s*i'?m)\s+([A-Z][a-z]{1,15})\b/,
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m) {
        const candidate = m[1].trim();
        const first = candidate.split(" ")[0].toLowerCase();
        if (!NOT_NAMES.has(first) && candidate.length >= 2 && candidate.length <= 32) {
          return { name: candidate, source: "website" };
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}
// ~939 US cities incl. North TX small towns. Population is a free, stable
// proxy for search demand (true keyword volume needs a paid tool).
// Numbers are approximate snapshots; fine for relative market ranking.
const CITY_POP: Record<string, number> = {
  "abilene":120099,"addison":37385,"akron":198100,"alameda":76419,"albany":98424,"albuquerque":556495,
  "alexandria":148892,"alhambra":84577,"aliso viejo":50175,"allen":110000,"allentown":118577,"alpharetta":62298,
  "altamonte springs":42150,"altoona":45796,"amarillo":196429,"ames":61792,"anaheim":345012,"anchorage":300950,
  "anderson":55670,"ankeny":51567,"ann arbor":117025,"anna":25000,"annapolis":38722,"antioch":107100,
  "apache junction":37130,"apex":42214,"apopka":45587,"apple valley":70924,"appleton":73596,"arcadia":57639,
  "arlington":379577,"arlington heights":75994,"arvada":111707,"asheville":87236,"athens-clarke county":119980,"atlanta":447841,
  "atlantic city":39551,"attleboro":43886,"aubrey":12000,"auburn":74860,"augusta-richmond county":197350,"aurora":345803,
  "austin":885400,"aventura":37199,"avondale":78822,"azusa":47842,"bakersfield":363630,"baldwin park":76635,
  "baltimore":622104,"barnstable town":44641,"bartlett":58226,"baton rouge":229426,"battle creek":51848,"bayonne":65028,
  "baytown":75418,"beaumont":117796,"beavercreek":45712,"beaverton":93542,"bedford":48592,"bell gardens":42889,
  "belleville":42895,"bellevue":133992,"bellflower":77593,"bellingham":82631,"beloit":36888,"bend":81236,
  "bentonville":40167,"berkeley":116768,"berwyn":56758,"bethlehem":75018,"beverly":40664,"billings":109059,
  "biloxi":44820,"binghamton":46444,"birmingham":212113,"bismarck":67034,"blacksburg":43609,"blaine":60407,
  "bloomington":86319,"blue springs":53294,"boca raton":89407,"boise city":214237,"bolingbrook":73936,"bonita springs":47547,
  "bossier city":66333,"boston":645966,"boulder":103166,"bountiful":43023,"bowie":56759,"bowling green":61488,
  "boynton beach":71097,"bozeman":39860,"bradenton":51763,"brea":40963,"bremerton":39056,"brentwood":55000,
  "bridgeport":147216,"bristol":60568,"brockton":94089,"broken arrow":103500,"brookfield":37999,"brookhaven":50603,
  "brooklyn park":78373,"broomfield":59471,"brownsville":181860,"bryan":78709,"buckeye":56683,"buena park":82882,
  "buffalo":258959,"buffalo grove":41778,"bullhead city":39383,"burbank":104709,"burien":49858,"burleson":40714,
  "burlington":51510,"burnsville":61434,"caldwell":48957,"calexico":39389,"calumet city":37240,"camarillo":66086,
  "cambridge":107289,"camden":76903,"campbell":40584,"canton":72535,"cape coral":165831,"cape girardeau":38816,
  "carlsbad":110972,"carmel":85927,"carol stream":40379,"carpentersville":38241,"carrollton":135000,"carson":92599,
  "carson city":54080,"cary":151088,"casa grande":50111,"casper":59628,"castle rock":53063,"cathedral city":52977,
  "cedar falls":40566,"cedar hill":46663,"cedar park":61238,"cedar rapids":128429,"celina":30000,"centennial":106114,
  "ceres":46714,"cerritos":49707,"champaign":83424,"chandler":249146,"chapel hill":59635,"charleston":127999,
  "charlotte":792862,"charlottesville":44349,"chattanooga":173366,"chelsea":37670,"chesapeake":230571,"chesterfield":47749,
  "cheyenne":62448,"chicago":2718782,"chico":88077,"chicopee":55717,"chino":80988,"chino hills":76572,
  "chula vista":256780,"cicero":84103,"cincinnati":297517,"citrus heights":85285,"clarksville":142357,"clearwater":109703,
  "cleveland":390113,"cleveland heights":45394,"clifton":85390,"clovis":99769,"coachella":43092,"coconut creek":56792,
  "coeur d'alene":46402,"college station":100050,"collierville":47333,"colorado springs":439886,"colton":53243,"columbia":133358,
  "columbus":822553,"commerce city":49799,"compton":97877,"concord":125880,"conroe":63032,"conway":63816,
  "coon rapids":62103,"coppell":40342,"coral gables":49631,"coral springs":126604,"corona":159503,"corpus christi":316381,
  "corvallis":55298,"costa mesa":112174,"council bluffs":61969,"covina":48508,"covington":40956,"cranston":80566,
  "cross roads":2000,"crystal lake":40388,"culver city":39428,"cupertino":60189,"cutler bay":43328,"cuyahoga falls":49267,
  "cypress":49087,"dallas":1300000,"daly city":104739,"danbury":83684,"danville":43341,"davenport":102157,
  "davie":96830,"davis":66205,"dayton":143355,"daytona beach":62316,"dearborn":95884,"dearborn heights":56620,
  "decatur":74710,"deerfield beach":78041,"dekalb":43849,"delano":52403,"delray beach":64072,"deltona":86290,
  "denton":150000,"denver":649495,"des moines":207510,"des plaines":58918,"desoto":51483,"detroit":688701,
  "diamond bar":56449,"doral":50213,"dothan":68001,"dover":37366,"downers grove":49670,"downey":113242,
  "draper":45285,"dublin":52105,"dubuque":58253,"duluth":86128,"duncanville":39605,"dunwoody":47591,
  "durham":245475,"eagan":65453,"east lansing":48554,"east orange":64544,"east providence":47149,"eastvale":55191,
  "eau claire":67545,"eden prairie":62603,"edina":49376,"edinburg":80836,"edmond":87004,"edmonds":40727,
  "el cajon":102211,"el centro":43363,"el monte":115708,"el paso":674433,"elgin":110145,"elizabeth":127558,
  "elk grove":161007,"elkhart":51265,"elmhurst":45556,"elyria":53956,"encinitas":61588,"enid":50725,
  "erie":100671,"escondido":148738,"euclid":48139,"eugene":159190,"euless":53224,"evanston":75570,
  "evansville":120310,"everett":105370,"fairfield":109320,"fairview":11000,"fall river":88697,"fargo":113658,
  "farmington":45426,"farmington hills":81295,"fayetteville":204408,"federal way":92734,"findlay":41512,"fishers":83891,
  "fitchburg":40383,"flagstaff":68667,"flint":99763,"florence":40059,"florissant":52363,"flower mound":68609,
  "folsom":73098,"fond du lac":42970,"fontana":203003,"fort collins":152061,"fort lauderdale":172389,"fort myers":68190,
  "fort pierce":43074,"fort smith":87650,"fort wayne":256496,"fort worth":792727,"fountain valley":56707,"franklin":68886,
  "frederick":66893,"freeport":43167,"fremont":224922,"fresno":509924,"friendswood":37587,"frisco":230000,
  "fullerton":138981,"gainesville":127488,"gaithersburg":65690,"galveston":48733,"garden grove":175140,"gardena":59957,
  "garland":234566,"gary":78450,"gastonia":73209,"georgetown":54898,"germantown":39375,"gilbert":229972,
  "gilroy":51701,"glendale":234632,"glendora":51074,"glenview":45417,"goodyear":72864,"goose creek":39823,
  "grand forks":54932,"grand island":50550,"grand junction":59778,"grand prairie":183372,"grand rapids":192294,"grapevine":50195,
  "great falls":59351,"greeley":96539,"green bay":104779,"greenacres":38696,"greenfield":37159,"greensboro":279639,
  "greenville":89130,"greenwood":53665,"gresham":109397,"grove city":37490,"gulfport":71012,"hackensack":44113,
  "hagerstown":40612,"hallandale beach":38632,"haltom city":43580,"hamilton":62258,"hammond":78967,"hampton":136699,
  "hanford":54686,"hanover park":38510,"harlingen":65665,"harrisburg":49188,"harrisonburg":51395,"hartford":125017,
  "hattiesburg":47556,"haverhill":62088,"hawthorne":86199,"hayward":151574,"hemet":81750,"hempstead":55361,
  "henderson":270811,"hendersonville":54068,"hesperia":92147,"hialeah":233394,"hickory":40361,"high point":107741,
  "highland":54291,"hillsboro":97368,"hilton head island":39412,"hoboken":52575,"hoffman estates":52398,"hollywood":146526,
  "holyoke":40249,"homestead":64079,"honolulu":347884,"hoover":84126,"houston":2195914,"huber heights":38142,
  "huntersville":50458,"huntington":49177,"huntington beach":197575,"huntington park":58879,"huntsville":186254,"hurst":38448,
  "hutchinson":41889,"idaho falls":58292,"independence":117240,"indianapolis":843393,"indio":83539,"inglewood":111542,
  "iowa city":71591,"irvine":236716,"irving":228653,"jackson":172638,"jacksonville":842583,"janesville":63820,
  "jefferson city":43330,"jeffersonville":45929,"jersey city":257342,"johns creek":82788,"johnson city":65123,"joliet":147806,
  "jonesboro":71551,"joplin":50789,"jupiter":58298,"jurupa valley":98030,"kalamazoo":75548,"kannapolis":44359,
  "kansas city":467007,"kearny":41664,"keizer":37064,"keller":42907,"kenner":66975,"kennewick":76762,
  "kenosha":99889,"kent":124435,"kentwood":50233,"kettering":55870,"killeen":137147,"kingsport":52962,
  "kirkland":84430,"kissimmee":65173,"knoxville":183270,"kokomo":56895,"krugerville":2000,"la crosse":51522,
  "la habra":61653,"la mesa":58642,"la mirada":49133,"la puente":40435,"la quinta":39331,"lacey":44919,
  "lafayette":124276,"laguna niguel":64652,"lake charles":74024,"lake elsinore":57525,"lake forest":79312,"lake havasu city":52844,
  "lake oswego":37610,"lakeland":100710,"lakeville":58562,"lakewood":147214,"lancaster":159523,"lansing":113972,
  "laredo":248142,"largo":78409,"las cruces":101324,"las vegas":603488,"lauderhill":69813,"lawrence":90811,
  "lawton":97151,"layton":70790,"league city":90983,"lee's summit":93184,"leesburg":47673,"lehi":54382,
  "lenexa":50344,"leominster":41002,"lewisville":130000,"lexington-fayette":308428,"lima":38355,"lincoln":268738,
  "lincoln park":37313,"linden":41301,"little elm":55000,"little rock":197357,"littleton":44275,"livermore":85156,
  "livonia":95208,"lodi":63338,"logan":48913,"lombard":43907,"lompoc":43509,"long beach":469428,
  "longmont":89919,"longview":81443,"lorain":63710,"los angeles":3884307,"louisville":609893,"loveland":71334,
  "lowell":108861,"lubbock":239538,"lucas":9000,"lynchburg":78014,"lynn":91589,"lynwood":71371,
  "macon":89981,"madera":63105,"madison":243344,"malden":60509,"manassas":41705,"manchester":110378,
  "manhattan":56143,"mankato":40641,"mansfield":60872,"manteca":71948,"maple grove":65415,"maplewood":39765,
  "marana":38290,"margate":55456,"maricopa":45508,"marietta":59089,"marlborough":39414,"martinez":37165,
  "marysville":63269,"mcallen":136639,"mckinney":215000,"medford":77677,"melbourne":77508,"melissa":20000,
  "memphis":653450,"menifee":83447,"mentor":46979,"merced":81102,"meriden":60456,"meridian":83596,
  "mesa":457587,"mesquite":143484,"methuen":48514,"miami":417650,"miami beach":91026,"miami gardens":111378,
  "middletown":48630,"midland":123933,"midwest city":56756,"milford":51644,"milpitas":69783,"milwaukee":599164,
  "minneapolis":400070,"minnetonka":51368,"minot":46321,"miramar":130288,"mishawaka":47989,"mission":81050,
  "mission viejo":96346,"missoula":69122,"missouri city":70185,"mobile":194899,"modesto":204933,"moline":43116,
  "monroe":49761,"monrovia":37101,"montclair":38027,"montebello":63495,"monterey park":61085,"montgomery":201332,
  "moore":58414,"moorhead":39398,"moreno valley":201175,"morgan hill":40836,"mount pleasant":74885,"mount prospect":54771,
  "mount vernon":68224,"mountain view":77846,"muncie":70316,"murfreesboro":117044,"murray":48612,"murrieta":107479,
  "muskegon":37213,"muskogee":38863,"nampa":86518,"napa":79068,"naperville":144864,"nashua":87137,
  "nashville":634464,"national city":59834,"new bedford":95078,"new berlin":39834,"new braunfels":63279,"new britain":72939,
  "new brunswick":55831,"new haven":130660,"new orleans":378715,"new rochelle":79446,"new york":8405837,"newark":278427,
  "newport beach":87273,"newport news":182020,"newton":87971,"niagara falls":49468,"noblesville":56540,"norfolk":246139,
  "normal":54664,"norman":118197,"north charleston":104054,"north las vegas":226877,"north lauderdale":42757,"north little rock":66075,
  "north miami":61007,"north miami beach":43250,"north port":59212,"north richland hills":67317,"northglenn":37499,"norwalk":106589,
  "norwich":40347,"novato":54194,"novi":57960,"o'fallon":82809,"oak lawn":57073,"oak park":52066,
  "oakland":406253,"oakland park":43286,"oakley":38194,"ocala":57468,"oceanside":172794,"ocoee":39172,
  "odessa":110720,"ogden":84249,"oklahoma city":610613,"olathe":131885,"olympia":48338,"omaha":434353,
  "ontario":167500,"orange":139969,"orem":91648,"orland park":58590,"orlando":255483,"ormond beach":38661,
  "oro valley":41627,"oshkosh":66778,"overland park":181260,"owensboro":58416,"oxnard":203007,"pacifica":38606,
  "palatine":69350,"palm bay":104898,"palm beach gardens":50699,"palm coast":78740,"palm desert":50508,"palm springs":46281,
  "palmdale":157161,"palo alto":66642,"panama city":36877,"paramount":54980,"park ridge":37839,"parker":48608,
  "parma":80429,"pasadena":152735,"pasco":67599,"passaic":70868,"paterson":145948,"pawtucket":71172,
  "peabody":52044,"peachtree corners":40059,"pearland":100065,"pembroke pines":162329,"pensacola":52703,"peoria":162592,
  "perris":72326,"perth amboy":51982,"petaluma":59440,"pflugerville":53752,"pharr":73790,"phenix city":37498,
  "philadelphia":1553165,"phoenix":1513367,"pico rivera":63771,"pilot point":6000,"pine bluff":46094,"pinellas park":49998,
  "pittsburg":66695,"pittsburgh":305841,"pittsfield":44057,"placentia":52206,"plainfield":50588,"plano":290000,
  "plantation":90268,"pleasanton":74110,"plymouth":73987,"pocatello":54350,"pomona":151348,"pompano beach":104410,
  "pontiac":59887,"port arthur":54135,"port orange":57203,"port st. lucie":171016,"portage":47523,"porterville":55174,
  "portland":609456,"portsmouth":96205,"poway":49417,"prescott":40590,"prescott valley":39791,"princeton":28000,
  "prosper":40000,"providence":177994,"providence village":8000,"provo":116288,"pueblo":108249,"puyallup":38609,
  "quincy":93494,"racine":78199,"raleigh":431746,"rancho cordova":67911,"rancho cucamonga":171386,"rancho palos verdes":42448,
  "rancho santa margarita":49228,"rapid city":70812,"reading":87893,"redding":91119,"redlands":69999,"redmond":57530,
  "redondo beach":67815,"redwood city":80872,"reno":233294,"renton":97003,"revere":53756,"rialto":101910,
  "richardson":104475,"richland":52413,"richmond":214114,"rio rancho":91956,"riverside":316619,"riverton":40921,
  "roanoke":98465,"rochester":210358,"rochester hills":72952,"rock hill":69103,"rock island":38877,"rockford":150251,
  "rocklin":59738,"rockville":64072,"rockwall":40922,"rocky mount":56954,"rogers":60112,"rohnert park":41398,
  "romeoville":39650,"rosemead":54561,"roseville":127035,"roswell":94034,"round rock":109821,"rowlett":58043,
  "roy":37733,"royal oak":58946,"sacramento":479686,"saginaw":50303,"salem":160614,"salina":47846,
  "salinas":155662,"salt lake city":191180,"sammamish":50169,"san angelo":97492,"san antonio":1409019,"san bernardino":213708,
  "san bruno":42443,"san buenaventura (ventura)":108817,"san clemente":65040,"san diego":1355896,"san francisco":837442,"san gabriel":40275,
  "san jacinto":45851,"san jose":998537,"san leandro":87965,"san luis obispo":46377,"san marcos":89387,"san mateo":101128,
  "san rafael":58994,"san ramon":74513,"sandy":90231,"sandy springs":99770,"sanford":56002,"sanger":10000,
  "santa ana":334227,"santa barbara":90412,"santa clara":120245,"santa clarita":179590,"santa cruz":62864,"santa fe":69976,
  "santa maria":102216,"santa monica":92472,"santa rosa":171990,"santee":56105,"sarasota":53326,"savannah":12000,
  "sayreville":44412,"schaumburg":74907,"schenectady":65902,"scottsdale":226918,"scranton":75806,"seattle":652405,
  "shakopee":39167,"shawnee":64323,"sheboygan":48725,"shelton":40999,"sherman":39296,"shoreline":54790,
  "shreveport":200327,"sierra vista":45129,"simi valley":126181,"sioux city":82459,"sioux falls":164676,"skokie":65176,
  "smyrna":53438,"somerville":78804,"south bend":100886,"south gate":95677,"south jordan":59366,"south san francisco":66174,
  "southaven":50997,"southfield":73006,"spanish fork":36956,"sparks":93282,"spartanburg":37647,"spokane":210721,
  "spokane valley":91113,"springdale":75229,"springfield":164122,"st. charles":67569,"st. clair shores":60070,"st. cloud":66297,
  "st. george":76817,"st. joseph":77147,"st. louis":318416,"st. louis park":47411,"st. paul":294873,"st. peters":54842,
  "st. petersburg":249688,"stamford":126456,"stanton":38623,"state college":41757,"sterling heights":131224,"stillwater":47186,
  "stockton":298118,"streamwood":40351,"strongsville":44730,"suffolk":85728,"sugar land":83860,"summerville":46074,
  "sumter":41190,"sunnyvale":147559,"sunrise":90116,"surprise":123546,"syracuse":144669,"tacoma":203446,
  "tallahassee":186411,"tamarac":63155,"tampa":352957,"taunton":56069,"taylor":61817,"taylorsville":60519,
  "temecula":106780,"tempe":168228,"temple":70190,"terre haute":61025,"texarkana":37442,"texas city":46081,
  "the colony":45000,"thornton":127359,"thousand oaks":128731,"tigard":50444,"tinley park":57282,"titusville":44206,
  "toledo":282313,"topeka":127679,"torrance":147478,"tracy":84691,"trenton":84349,"troy":82821,
  "tucson":526116,"tulare":61170,"tulsa":398121,"turlock":70365,"tuscaloosa":95334,"tustin":78327,
  "twin falls":45981,"tyler":100223,"union city":72528,"upland":75413,"urbana":41752,"urbandale":41776,
  "utica":61808,"vacaville":94275,"valdosta":56481,"vallejo":118837,"valley stream":37659,"vancouver":167405,
  "victoria":65098,"victorville":121096,"vineland":61050,"virginia beach":448479,"visalia":127763,"vista":96929,
  "waco":129030,"walnut creek":66900,"waltham":62227,"warner robins":72531,"warren":134873,"warwick":81971,
  "washington":646449,"waterbury":109676,"waterloo":68366,"watsonville":52477,"waukegan":88826,"waukesha":71016,
  "wausau":39309,"wauwatosa":47134,"wellington":60202,"weslaco":37093,"west allis":60697,"west covina":107740,
  "west des moines":61255,"west haven":55046,"west jordan":110077,"west new york":52122,"west palm beach":102436,"west sacramento":49891,
  "west valley city":133579,"westerville":37530,"westfield":41301,"westland":82578,"westminster":110945,"weston":68388,
  "weymouth town":55419,"wheaton":53648,"wheeling":38015,"white plains":57866,"whittier":86635,"wichita":386552,
  "wichita falls":104898,"wilkes-barre":41108,"wilmington":112067,"wilson":49628,"winston-salem":236441,"winter garden":37711,
  "woburn":39083,"woodbury":65656,"woodland":56590,"woonsocket":41026,"worcester":182544,"wylie":60000,
  "wyoming":74100,"yakima":93257,"yonkers":199766,"yorba linda":67032,"york":43935,"youngstown":65184,
  "yuba city":65416,"yucaipa":52536,"yuma":91923,
};

// Pull a recognizable city name out of the user's free-text query.
function detectCity(query: string): { city: string | null; pop: number | null } {
  const q = query.toLowerCase();
  // Check multi-word names first so "little elm" isn't read as "elm".
  const names = Object.keys(CITY_POP).sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (q.includes(name)) return { city: name, pop: CITY_POP[name] };
  }
  return { city: null, pop: null };
}

// Score the demand side from population. 0-100.
function demandScore(pop: number | null): number {
  if (pop === null) return 50; // unknown city -> neutral
  if (pop >= 200000) return 100;
  if (pop >= 120000) return 85;
  if (pop >= 80000) return 70;
  if (pop >= 45000) return 55;
  if (pop >= 25000) return 40;
  if (pop >= 12000) return 28;
  return 18;
}

// Analyze the whole field of results to gauge how hard the market is.
// Returns 0-100 where HIGH = wide open (weak/few competitors = good for you).
function competitionOpenness(allPlaces: any[]): { openness: number; field: number; avgReviews: number; strong: number } {
  const valid = allPlaces.filter(p => (p.userRatingCount ?? 0) >= 5);
  const field = valid.length;
  if (field === 0) return { openness: 70, field: 0, avgReviews: 0, strong: 0 };

  const reviewCounts = valid.map(p => p.userRatingCount ?? 0);
  const avgReviews = Math.round(reviewCounts.reduce((a, b) => a + b, 0) / field);
  // "Strong" competitors = the wall a newcomer has to climb past.
  const strong = valid.filter(p => (p.userRatingCount ?? 0) >= 100).length;

  let openness = 100;
  // More competitors = harder.
  if (field >= 18) openness -= 30;
  else if (field >= 12) openness -= 18;
  else if (field >= 7) openness -= 8;
  // Entrenched leaders = much harder to outrank.
  openness -= Math.min(40, strong * 7);
  // High average review depth = mature, competitive market.
  if (avgReviews >= 150) openness -= 18;
  else if (avgReviews >= 70) openness -= 8;

  openness = Math.max(5, Math.min(100, openness));
  return { openness, field, avgReviews, strong };
}

// Score a lead 0-100 against the ideal profile.
function scoreLead(p: any, market: { score: number; label: string; reason: string }): Lead | null {
  const now = Date.now();
  const rating: number = p.rating ?? 0;
  const reviews: number = p.userRatingCount ?? 0;
  const status: string = p.businessStatus ?? "";
  const website: string | null = p.websiteUri ?? null;
  const address: string = p.formattedAddress ?? "";

  // HARD FILTERS — drop anything that fails these outright.
  if (status && status !== "OPERATIONAL") return null;
  if (rating < 4.5) return null;
  if (reviews < 10) return null;
  if (!address) return null; // must have a physical address

  // Derive review-age signals from the returned reviews (up to ~5).
  let oldestYears: number | null = null;
  let lastDays: number | null = null;
  if (Array.isArray(p.reviews) && p.reviews.length) {
    const times = p.reviews
      .map((r: any) => (r.publishTime ? new Date(r.publishTime).getTime() : null))
      .filter((t: number | null): t is number => t !== null);
    if (times.length) {
      const oldest = Math.min(...times);
      const newest = Math.max(...times);
      oldestYears = +(daysBetween(oldest, now) / 365).toFixed(1);
      lastDays = daysBetween(newest, now);
    }
  }

  // ---- Owner name detection ----
  // Primary signal (the one we want most): a first name customers mention
  // consistently across multiple reviews is very likely the owner/operator.
  // The owner's own review replies are used to corroborate. We never guess —
  // when the evidence is thin we mark it low confidence so it's clear on the call.
  const reviewsArr = p.reviews ?? [];
  const consensus = extractOwnerFromReviewText(reviewsArr, p.displayName?.text ?? "");
  const reply = extractOwnerFromReviews(reviewsArr);

  let ownerName: string | null = null;
  let ownerSource: string | null = null;
  let ownerConfidence: Lead["ownerConfidence"] = null;

  if (consensus) {
    const crossConfirmed = !!reply && reply.name.toLowerCase() === consensus.name.toLowerCase();
    ownerName = consensus.name;
    if (consensus.ambiguous) {
      ownerConfidence = "low";
      ownerSource = `unsure — reviewers name both ${consensus.name} and ${consensus.runnerUp}`;
    } else if (crossConfirmed) {
      ownerConfidence = "high";
      ownerSource = `named in ${consensus.hits} review${consensus.hits > 1 ? "s" : ""} + owner reply`;
    } else if (consensus.hits >= 3) {
      ownerConfidence = "high";
      ownerSource = `named in ${consensus.hits} of ${consensus.total} reviews`;
    } else if (consensus.hits === 2) {
      ownerConfidence = "medium";
      ownerSource = `named in 2 of ${consensus.total} reviews`;
    } else {
      ownerConfidence = "low";
      ownerSource = "named in only 1 review — unconfirmed";
    }
  } else if (reply) {
    ownerName = reply.name;
    ownerConfidence = "medium";
    ownerSource = "from owner's review reply";
  }

  let websiteFlag: Lead["websiteFlag"] = "unknown";
  if (!website) {
    websiteFlag = "none";
  } else {
    const w = website.toLowerCase();
    // Social pages / builders / link-in-bio usually = weak web presence.
    const weakHosts = [
      "facebook.com", "instagram.com", "linktr.ee", "linktree",
      "business.site", "wixsite.com", "godaddysites.com", "weebly.com",
      "blogspot.", "wordpress.com", "yelp.com", "google.com",
    ];
    if (weakHosts.some((h) => w.includes(h))) websiteFlag = "weak";
    else websiteFlag = "ok";
  }

  // ---- Scoring ----
  let score = 0;
  const reasons: string[] = [];

  // Review count sweet spot 20-100 = best.
  if (reviews >= 20 && reviews <= 100) { score += 30; reasons.push("Reviews in 20-100 sweet spot"); }
  else if (reviews > 100) { score += 18; reasons.push("100+ reviews (bigger, may have help)"); }
  else { score += 14; reasons.push("10-19 reviews"); }

  // Rating quality.
  if (rating >= 4.8) { score += 18; reasons.push("Excellent rating"); }
  else if (rating >= 4.5) { score += 14; reasons.push("Strong rating"); }

  // ---- Maturity read ----
  // Review COUNT is the reliable "are they established" signal; the oldest
  // review DATE is only a weak hint (API returns ~5 reviews, rarely the oldest),
  // so we lean on count and use a confirmed-old review only to upgrade.
  let maturity: Lead["maturity"];
  let maturityNote: string;
  const hasOldReview = oldestYears !== null && oldestYears >= 4;

  if (reviews >= 50 || hasOldReview) {
    maturity = "Established";
    maturityNote = hasOldReview
      ? `Established \u2014 ${reviews} reviews, review history ${oldestYears}+ yrs`
      : `Established \u2014 ${reviews} reviews (built over years)`;
    score += 22;
  } else if (reviews >= 20) {
    maturity = "Growing";
    maturityNote = `Growing \u2014 ${reviews} reviews`;
    score += 14;
  } else {
    maturity = "Newer";
    maturityNote = `Newer / smaller \u2014 ${reviews} reviews`;
    score += 6;
  }
  reasons.push(maturityNote);

  // Recent activity (still getting reviews = active).
  if (lastDays !== null) {
    if (lastDays <= 90) { score += 15; reasons.push("Active review in last 90d"); }
    else if (lastDays <= 180) { score += 8; reasons.push("Review in last 6mo"); }
    else { score += 2; reasons.push("No recent reviews"); }
  } else {
    score += 5;
  }

  // Website weakness = OPPORTUNITY (this is the pitch).
  if (websiteFlag === "none") { score += 15; reasons.push("No website — prime target"); }
  else if (websiteFlag === "weak") { score += 12; reasons.push("Weak web presence — good target"); }
  else if (websiteFlag === "ok") { score += 3; reasons.push("Has a real website"); }

  score = Math.min(100, score);

  const phoneRaw = (p.nationalPhoneNumber ?? p.internationalPhoneNumber ?? "").replace(/[^\d+]/g, "");

  return {
    name: p.displayName?.text ?? "Unknown",
    address,
    phone: p.nationalPhoneNumber ?? p.internationalPhoneNumber ?? "",
    phoneRaw,
    phoneE164: toE164(p.nationalPhoneNumber ?? "", p.internationalPhoneNumber ?? ""),
    lineType: null,
    carrierName: null,
    website,
    rating,
    reviews,
    oldestReviewYearsAgo: oldestYears,
    lastReviewDaysAgo: lastDays,
    maturity,
    maturityNote,
    ownerName,
    ownerSource,
    ownerConfidence,
    websiteFlag,
    score,
    scoreReasons: reasons,
    mapsUrl: p.googleMapsUri ?? "",
    marketScore: market.score,
    marketLabel: market.label,
    marketReason: market.reason,
  };
}

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405 });
  }
  if (!(await isAuthed(req))) return unauthorized();

  const apiKey = Netlify.env.get("GOOGLE_PLACES_KEY");
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "Server is missing GOOGLE_PLACES_KEY. Add it in Netlify env vars." }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
  }

  const query: string = (body.query ?? "").toString().trim();
  if (!query) {
    return new Response(JSON.stringify({ error: "Missing search query" }), { status: 400 });
  }

  // When true, keep ONLY confirmed mobile/cell numbers (also drops VoIP +
  // undetermined lines). Landlines are always dropped regardless. Only has an
  // effect when Twilio line-type lookup is configured.
  const mobileOnly: boolean = body.mobileOnly === true;

  // Deep search: after the normal query, tile the surrounding area into a grid
  // and search each cell, so we pull FAR more businesses (into the hundreds)
  // instead of Google's 60-per-query ceiling. Uses more Google/Twilio credit.
  const deep: boolean = body.deep === true;
  let partial = false;

  try {
    // ---- Search-result cache (the big cost saver) ----
    // The expensive part is the Google Places calls — a deep search fires ~13, and
    // Google bills each one (the review-data tier is their priciest). A business
    // list barely changes day to day, so we cache the gathered results per
    // (query + deep) for a few days: re-running a recent search costs $0 in Google
    // credit. Send fresh:true to force a live re-pull.
    const searchStore = getStore("leadsearch");
    const cacheKey = "s:" + (deep ? "d:" : "n:") + query.toLowerCase().replace(/\s+/g, " ").trim();
    const SEARCH_TTL = 5 * 86400000; // 5 days

    let uniquePlaces: any[] = [];
    let center: { lat: number; lng: number } | null = null;
    let centerSource = "none";
    let market: { score: number; label: string; reason: string } = { score: 0, label: "", reason: "" };
    let farHidden = 0;
    let fromCache = false;

    const cachedSearch = body.fresh ? null : ((await searchStore.get(cacheKey, { type: "json" }).catch(() => null)) as any);
    if (cachedSearch && cachedSearch.at && Date.now() - cachedSearch.at < SEARCH_TTL && Array.isArray(cachedSearch.places)) {
      // Reuse the gathered businesses — no Google calls at all.
      uniquePlaces = cachedSearch.places;
      center = cachedSearch.center || null;
      centerSource = cachedSearch.centerSource || "none";
      market = cachedSearch.market || market;
      farHidden = cachedSearch.farHidden || 0;
      fromCache = true;
    } else {
      // ---- Gather from Google (seed query + optional deep tiling) ----
      // Google Text Search returns 20/page, up to 3 pages (60 max) via
      // nextPageToken. For a deep search we only take 1 seed page (the tiles
      // provide the volume) to save Google calls.
      const places: any[] = [];
      let pageToken = "";
      for (let page = 0; page < (deep ? 1 : 3); page++) {
        const reqBody: any = { textQuery: query, pageSize: 20, languageCode: "en", regionCode: "US" };
        if (pageToken) reqBody.pageToken = pageToken;
        const res = await fetch(PLACES_SEARCH, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Goog-Api-Key": apiKey,
            "X-Goog-FieldMask": FIELD_MASK + ",nextPageToken",
          },
          body: JSON.stringify(reqBody),
        });
        if (!res.ok) {
          if (places.length) break;
          const errText = await res.text();
          return new Response(
            JSON.stringify({ error: "Google Places error", detail: errText }),
            { status: 502, headers: { "content-type": "application/json" } }
          );
        }
        const data = await res.json();
        for (const p of (data.places ?? [])) places.push(p);
        pageToken = data.nextPageToken || "";
        if (!pageToken) break;
      }

      // ---- Market analysis (from the seed results) ----
      const { city, pop } = detectCity(query);
      const demand = demandScore(pop);
      const comp = competitionOpenness(places);
      const marketScore = Math.round(demand * 0.45 + comp.openness * 0.55);
      let marketLabel = "Tough market";
      if (marketScore >= 75) marketLabel = "Goldmine";
      else if (marketScore >= 60) marketLabel = "Strong";
      else if (marketScore >= 45) marketLabel = "Decent";
      const cityName = city ? city.replace(/\b\w/g, c => c.toUpperCase()) : "Unknown city";
      const popText = pop ? `~${(pop / 1000).toFixed(0)}k pop` : "pop unknown";
      const compText = comp.field <= 7
        ? `light competition (${comp.field} listings)`
        : comp.strong >= 4
          ? `crowded — ${comp.strong} entrenched leaders`
          : `${comp.field} competitors, ${comp.strong} strong`;
      market = { score: marketScore, label: marketLabel, reason: `${cityName}: ${popText}, ${compText}` };

      // ---- City center (anchor the near-radius on the searched city) ----
      const seedLocs = places.map((p) => p.location).filter((l: any) => l && typeof l.latitude === "number" && typeof l.longitude === "number");
      const locText = /\bin\b/i.test(query) ? query.split(/\bin\b/i).slice(1).join(" in ").trim() : (detectCity(query).city || "");
      center = locText ? await cityCenter(apiKey, locText) : null;
      centerSource = center ? "city" : "none";
      if (!center && seedLocs.length >= 3) {
        center = { lat: median(seedLocs.map((l: any) => l.latitude)), lng: median(seedLocs.map((l: any) => l.longitude)) };
        centerSource = "median";
      }

      // ---- DEEP SEARCH: tile the area around the city center ----
      if (deep && center) {
        const niche = query.split(/\s+in\s+/i)[0].trim() || query;
        const radLat = NEAR_RADIUS_M / 111000;
        const radLng = NEAR_RADIUS_M / (111000 * Math.cos((center.lat * Math.PI) / 180));
        const minLat = center.lat - radLat, maxLat = center.lat + radLat;
        const minLng = center.lng - radLng, maxLng = center.lng + radLng;
        const N = 3; // 3×3 grid across the near-area
        const tiles: any[] = [];
        for (let i = 0; i < N; i++) {
          for (let j = 0; j < N; j++) {
            tiles.push({
              low: { latitude: minLat + (maxLat - minLat) * (i / N), longitude: minLng + (maxLng - minLng) * (j / N) },
              high: { latitude: minLat + (maxLat - minLat) * ((i + 1) / N), longitude: minLng + (maxLng - minLng) * ((j + 1) / N) },
            });
          }
        }
        const gatherDeadline = Date.now() + 13000;
        const tileResults = await pool(tiles, 6, async (rect) => {
          if (Date.now() > gatherDeadline) { partial = true; return [] as any[]; }
          return await tileSearch(apiKey, niche, rect, 1);
        });
        for (const arr of tileResults) for (const p of arr) places.push(p);
      }

      // Dedupe (tiles overlap the seed and each other). Prefer the stable place
      // id, but fall back to phone+name so a business that comes back WITHOUT an
      // id can't slip through as a duplicate.
      const seenIds = new Set<string>();
      uniquePlaces = places.filter((p) => {
        const key = (p.id || "").toString() ||
          ((p.nationalPhoneNumber || p.internationalPhoneNumber || "") + "|" + (p.displayName?.text || "")).trim();
        if (!key || key === "|") return true;
        if (seenIds.has(key)) return false;
        seenIds.add(key);
        return true;
      });

      // Keep only businesses near the searched city (drop far + un-locatable).
      if (center) {
        const before = uniquePlaces.length;
        uniquePlaces = uniquePlaces.filter((p) => {
          const l = p.location;
          if (!l || typeof l.latitude !== "number") return false;
          return distMeters(center!.lat, center!.lng, l.latitude, l.longitude) <= NEAR_RADIUS_M;
        });
        farHidden = before - uniquePlaces.length;
      }

      // Save for cheap re-runs.
      try { await searchStore.setJSON(cacheKey, { at: Date.now(), places: uniquePlaces, center, centerSource, market, farHidden }); } catch {}
    }

    let leads: Lead[] = uniquePlaces
      .map((p) => scoreLead(p, market))
      .filter((l: Lead | null): l is Lead => l !== null)
      .sort((a, b) => b.score - a.score);

    // Cap how many we enrich (Twilio + website) so cost/time stay bounded.
    const CAP = deep ? 150 : 60;
    if (leads.length > CAP) leads = leads.slice(0, CAP);

    // For leads that don't already have an owner name from a review reply,
    // try their website in parallel (best-effort, time-limited). Cap how many
    // sites we hit so the search stays fast and cheap.
    const needsScrape = leads.filter((l) => !l.ownerName && l.website).slice(0, deep ? 12 : 20);
    await pool(needsScrape, 12, async (l) => {
      const found = await extractOwnerFromWebsite(l.website as string);
      if (found) {
        l.ownerName = found.name;
        l.ownerSource = found.source;
        l.ownerConfidence = "medium";
      }
    });

    // ---- Phone line-type: mobile vs landline (needs Twilio credentials) ----
    // A mobile number is a far better lead — a direct shot at the owner instead
    // of a receptionist or office line — so confirmed mobiles get boosted to the
    // top. Entirely skipped (no cost, no change) if Twilio isn't configured.
    let landlineHidden = 0;
    let nonMobileHidden = 0;
    let phoneCached = 0, phoneFresh = 0;
    const twSid = Netlify.env.get("TWILIO_ACCOUNT_SID");
    const twToken = Netlify.env.get("TWILIO_AUTH_TOKEN");
    if (twSid && twToken) {
      const store = getStore("linetype");
      const MAX_AGE = 180 * 86400000; // re-check a number at most ~every 6 months

      // 1) Fill line types from the cache first. A number's type doesn't change,
      //    so once we've looked it up we NEVER pay Twilio for it again.
      await pool(leads, 30, async (l) => {
        if (!l.phoneE164) return;
        const c = (await store.get("lt:" + l.phoneE164, { type: "json" }).catch(() => null)) as any;
        if (c && c.type && Date.now() - (c.at || 0) < MAX_AGE) {
          l.lineType = c.type; l.carrierName = c.carrier || null; phoneCached++;
        }
      });

      // 2) Look up ONLY numbers we've never seen — and cap how many we pay for in
      //    one search. Results are cached so future searches reuse them for free.
      const twDeadline = Date.now() + (deep ? 12000 : 20000);
      const toLookup = leads.filter((l) => l.phoneE164 && !l.lineType).slice(0, MAX_NEW_LOOKUPS);
      await pool(toLookup, 15, async (l) => {
        if (Date.now() > twDeadline) { partial = true; return; }
        const lt = await lookupLineType(l.phoneE164 as string, twSid, twToken);
        if (!lt) return;
        l.lineType = lt.type; l.carrierName = lt.carrier; phoneFresh++;
        try { await store.setJSON("lt:" + l.phoneE164, { type: lt.type, carrier: lt.carrier, at: Date.now() }); } catch {}
      });

      // 3) Apply the mobile/VoIP score boosts now that we know each line type.
      for (const l of leads) {
        if (l.lineType === "mobile") {
          l.score = Math.min(100, l.score + 20);
          l.scoreReasons.unshift("📱 Mobile/cell — direct line to owner");
        } else if (l.lineType === "voip") {
          l.score = Math.min(100, l.score + 8);
          l.scoreReasons.unshift("🔀 VoIP — may ring the owner's cell");
        }
      }

      // 4) Drop landline-only leads (always) and, when mobileOnly is on, VoIP +
      //    undetermined lines too — so only confirmed mobiles remain.
      for (let i = leads.length - 1; i >= 0; i--) {
        const lt = leads[i].lineType;
        if (lt === "landline") { leads.splice(i, 1); landlineHidden++; continue; }
        if (mobileOnly && lt !== "mobile") { leads.splice(i, 1); nonMobileHidden++; }
      }

      // Re-sort so the boosted mobile/VoIP leads rise to the top.
      leads.sort((a, b) => b.score - a.score);
    }

    // Tag every lead with the exact search that found it, so it can go in the
    // GHL call-prep note (e.g. "septic service in Prosper TX").
    for (const l of leads) (l as any).searchTerm = query;

    return new Response(
      JSON.stringify({
        count: leads.length,
        scanned: uniquePlaces.length,
        landlineHidden,
        nonMobileHidden,
        farHidden,
        phoneCached,
        phoneFresh,
        fromCache,
        center,
        centerSource,
        mobileOnly,
        deep,
        partial,
        market,
        leads,
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  } catch (e: any) {
    return new Response(
      JSON.stringify({ error: "Request failed", detail: String(e?.message ?? e) }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }
};

export const config: Config = {
  path: "/api/leads",
};
