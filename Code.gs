/**
 * ============================================================
 *  ASLAN LESSONS — server (Google Apps Script)
 *  Bütün məlumatlar Google Cədvəldə saxlanılır.
 * ============================================================
 *
 *  QURAŞDIRMA:
 *  1) SPREADSHEET_URL — Google Cədvəlin linki (skript cədvəlin içindən açılıbsa, boş saxlayın).
 *  2) MAIN_ADMIN və DEVELOPER — ilkin login/şifrələr. setup()-dan əvvəl dəyişin.
 *  3) Redaktorda setup() funksiyasını bir dəfə işə salın.
 *  4) Yerləşdir → Veb tətbiq → «İcra edən: Mən», «Giriş: Hər kəs». URL-i index.html-də API_URL-ə yazın.
 *  5) Triggerlər setup() zamanı avtomatik qurulur:
 *     purgeTrashDaily (hər gün — zibil qutusu), autoArchiveQuarterly (hər ay yoxlayır, 3 aydan bir arxivləşdirir).
 *  Kodu yenilədikdən sonra setup()-ı bir dəfə yenidən işə salın (yeni icazələr və triggerlər üçün).
 */

// ===================== AYARLAR =====================
const SPREADSHEET_URL = '';            // məsələn: 'https://docs.google.com/spreadsheets/d/XXXX/edit'
const TIMEZONE = 'Asia/Baku';
const TZ_OFFSET = '+04:00';
const MAIN_ADMIN = { name: 'Baş admin', login: 'admin', password: 'admin123' };
const DEVELOPER   = { name: 'Developer', login: 'developer', password: 'dev12345' };
const SESSION_SECONDS = 6 * 60 * 60;
const EDIT_WINDOW_HOURS = 24;
const MAX_LOGIN_FAILS = 5;
const LOGIN_LOCK_MINUTES = 10;
const TRASH_DAYS = 30;                  // zibil qutusunda saxlama müddəti
const SURVEY_TTL_DAYS = 14;             // sorğu linkinin etibarlılıq müddəti
const ARCHIVE_MONTHS = 3;               // jurnal son 3 ayı göstərir; bundan köhnə qeydlər arxivə köçürülür
const AUTO_ARCHIVE_DAYS = 90;           // avto-arxiv neçə gündən bir işləyir (3 ay)
const ARCHIVE_BATCH = 4000;             // bir dəfədə arxivləşən maksimum sətir
// Arxivləşə bilən vərəqlər və tarix sütunu. Aktiv məlumatlar arxivlənmir (bax ARCHIVE_LOCKED).
const ARCHIVE_SHEETS = { Logs: 'time', Notifs: 'createdAt', Surveys: 'sentAt', Anns: 'createdAt' };
const ARCHIVE_LABELS = { Logs: 'Jurnal', Notifs: 'Bildirişlər', Surveys: 'Sorğu cavabları', Anns: 'Passiv elanlar' };
const ARCHIVE_NOTES = {
  Logs: 'Əməliyyatlar tarixçəsi. İstifadəçi və əməliyyat növünə görə süzmək olar.',
  Notifs: 'Köhnə bildirişlər.',
  Surveys: 'Arxivlənən cavablar sorğu statistikasından çıxır. Açıq linklərə toxunulmur.',
  Anns: 'Yalnız söndürülmüş elanlar. Aktiv elanlara toxunulmur.'
};
const ARCHIVE_LOCKED = ['Dərslər', 'Tələbələr', 'Müəllimlər', 'Məşğələlər', 'Ödənişlər', 'Köçürmələr (tələbə tarixçəsi)'];
const AUTO_ARCHIVE_SHEETS = ['Logs', 'Notifs']; // avto-arxiv yalnız bunları daşıyır
const STALE_DAYS = 14;                  // «Diqqət»: neçə gün dərs qeyd olunmayan məşğələ xəbərdarlıq alır
// Test məlumatları generatoru (yalnız developer) — bir dəfədə maksimum say
const TEST_LIMITS = { teachers: 20, students: 200, courses: 60, lessons: 12 };
// Avtomatik qurulan triggerlər
const TRIGGERS = [
  { fn: 'purgeTrashDaily', label: 'Zibil qutusunun təmizlənməsi (hər gün)', make: function (b) { return b.timeBased().everyDays(1).atHour(4); } },
  { fn: 'autoArchiveQuarterly', label: 'Avtomatik arxiv (3 aydan bir)', make: function (b) { return b.timeBased().onMonthDay(1).atHour(3); } }
];

// ===================== STRUKTUR =====================
const SCHEMA = {
  Users:    ['id', 'name', 'login', 'password', 'role', 'phone', 'permissions', 'theme', 'createdAt', 'updatedAt', 'deletedAt', 'deletedBy', 'installHint', 'newsSeenAt', 'isTest'],
  Students: ['id', 'name', 'phone', 'parentName', 'parentPhone', 'note', 'cardToken', 'status', 'createdAt', 'updatedAt', 'deletedAt', 'deletedBy', 'isTest'],
  Courses:  ['id', 'title', 'type', 'teacherId', 'studentIds', 'lessonsPerMonth', 'monthNo', 'monthStart', 'createdAt', 'updatedAt', 'deletedAt', 'deletedBy', 'isTest'],
  Lessons:  ['id', 'lessonId', 'courseId', 'monthNo', 'date', 'studentId', 'status', 'reason', 'topic', 'markedBy', 'markedAt', 'editedBy', 'editedAt'],
  Payments: ['id', 'studentId', 'courseId', 'monthNo', 'amount', 'date', 'note', 'createdBy', 'createdAt'],
  Transfers:['id', 'studentId', 'fromCourseId', 'toCourseId', 'byUser', 'at', 'note'],
  Notifs:   ['id', 'userId', 'type', 'text', 'page', 'param', 'createdAt', 'readAt'],
  Anns:     ['id', 'title', 'body', 'popup', 'active', 'createdBy', 'createdAt', 'updatedAt'],
  AnnSeen:  ['id', 'annId', 'userId', 'dismissedAt', 'popupSeenAt'],
  Surveys:  ['id', 'token', 'studentId', 'courseId', 'teacherId', 'monthNo', 'status', 'qVersion', 'questions', 'answers', 'sentBy', 'sentAt', 'answeredAt', 'adminStatus', 'adminNote', 'lowFlag'],
  Changelog:['id', 'title', 'body', 'kind', 'createdBy', 'createdAt'],
  Settings: ['key', 'value', 'updatedAt'],
  Logs:     ['id', 'time', 'userId', 'userName', 'role', 'type', 'action', 'details']
};

const SOFT = { Users: true, Students: true, Courses: true }; // zibil qutusu olan vərəqlər

const ROLE_LABELS = { superadmin: 'Baş admin', teacher: 'Müəllim', helper: 'Köməkçi', developer: 'Developer' };
const TYPE_LABELS = { individual: 'Fərdi', group: 'Qrup' };
const HELD = 'keçdi';
const ABSENT = 'qayıb';

const PERMISSIONS = [
  { group: 'Tələbələr', items: [
    { key: 'students.view', label: 'Tələbələrə bax' },
    { key: 'students.add', label: 'Tələbə əlavə et' },
    { key: 'students.edit', label: 'Tələbəni redaktə et' },
    { key: 'students.delete', label: 'Tələbəni sil' }
  ]},
  { group: 'Müəllimlər', items: [
    { key: 'teachers.view', label: 'Müəllimlərə bax' },
    { key: 'teachers.add', label: 'Müəllim əlavə et' },
    { key: 'teachers.edit', label: 'Müəllimi redaktə et' },
    { key: 'teachers.delete', label: 'Müəllimi sil' },
    { key: 'teachers.passwords', label: 'Şifrələrə bax' }
  ]},
  { group: 'Məşğələlər', items: [
    { key: 'courses.view', label: 'Məşğələlərə bax' },
    { key: 'courses.add', label: 'Məşğələ yarat' },
    { key: 'courses.edit', label: 'Məşğələni redaktə et' },
    { key: 'courses.delete', label: 'Məşğələni sil' },
    { key: 'month.new', label: 'Yeni ay başlat' }
  ]},
  { group: 'Dərs qeydləri', items: [
    { key: 'attendance.view', label: 'Dərs tarixçəsinə bax' },
    { key: 'attendance.mark', label: 'İstənilən məşğələdə dərs qeyd et' },
    { key: 'attendance.edit', label: 'Dərs qeydlərini düzəlt' },
    { key: 'attendance.delete', label: 'Dərs qeydlərini sil' }
  ]},
  { group: 'Ödənişlər', items: [
    { key: 'payments.view', label: 'Ödənişlərə bax' },
    { key: 'payments.add', label: 'Ödəniş əlavə et' },
    { key: 'payments.delete', label: 'Ödənişi sil' }
  ]},
  { group: 'Sorğular', items: [
    { key: 'survey.view', label: 'Sorğu cavablarına bax' },
    { key: 'survey.send', label: 'Sorğu linki göndər' },
    { key: 'survey.edit', label: 'Sorğu suallarını redaktə et' }
  ]},
  { group: 'Elanlar', items: [
    { key: 'announce.send', label: 'Elan göndər' }
  ]},
  { group: 'Alətlər', items: [
    { key: 'tools.trash', label: 'Zibil qutusu (bərpa/sil)' },
    { key: 'tools.bulk', label: 'Toplu əməliyyatlar (müəllim dəyişmə, köçürmə)' },
    { key: 'tools.datacheck', label: 'Məlumatların yoxlanışı' }
  ]},
  { group: 'Jurnal', items: [
    { key: 'logs.view', label: 'Jurnala bax' }
  ]}
];

const ALL_PERMS = [];
const PERM_LABEL = {};
PERMISSIONS.forEach(function (g) { g.items.forEach(function (i) { ALL_PERMS.push(i.key); PERM_LABEL[i.key] = i.label; }); });

const IMPLIED = {
  'students.add': ['students.view'], 'students.edit': ['students.view'], 'students.delete': ['students.view'],
  'teachers.add': ['teachers.view'], 'teachers.edit': ['teachers.view'], 'teachers.delete': ['teachers.view'], 'teachers.passwords': ['teachers.view'],
  'courses.add': ['courses.view'], 'courses.edit': ['courses.view'], 'courses.delete': ['courses.view'], 'month.new': ['courses.view'],
  'attendance.mark': ['courses.view'],
  'attendance.edit': ['attendance.view', 'courses.view'], 'attendance.delete': ['attendance.view', 'courses.view'],
  'payments.view': ['students.view'], 'payments.add': ['payments.view', 'students.view'], 'payments.delete': ['payments.view', 'students.view'],
  'survey.send': ['students.view'], 'survey.view': ['students.view'],
  'tools.bulk': ['courses.view']
};

const STUDENT_FIELDS = { name: 'Ad Soyad', phone: 'Telefon', parentName: 'Valideyn', parentPhone: 'Valideynin telefonu', note: 'Qeyd' };

// Sorğunun ilkin (default) sualları — redaktə etmək olar, köhnə cavablar öz versiyası ilə saxlanılır.
const DEFAULT_SURVEY = {
  version: 1,
  intro: 'Xidmətlərimizin keyfiyyətini artırmaq üçün bu qısa sorğunu cavablandırmağınızı xahiş edirik. Cavablarınız anonim deyil, lakin yalnız rəhbərlik tərəfindən görünür.',
  questions: [
    { id: 'q1', type: 'scale5', teacher: true, text: 'Müəllimin mövzuları izah etmə bacarığını necə qiymətləndirirsiniz?' },
    { id: 'q2', type: 'scale5', teacher: true, text: 'Bu ay övladınızın biliklərində irəliləyiş hiss edirsinizmi?' },
    { id: 'q3', type: 'choice', options: ['Bəli', 'Qismən', 'Xeyr'], bad: ['Xeyr'], text: 'Övladınız dərslərə həvəslə gedirmi?' },
    { id: 'q4', type: 'scale5', teacher: true, text: 'Müəllimin övladınıza münasibətindən razısınızmı?' },
    { id: 'q5', type: 'scale5', teacher: true, text: 'Müəllim dərsə vaxtında başlayır və dərs vaxtından səmərəli istifadə edirmi?' },
    { id: 'q6', type: 'scale5', teacher: true, text: 'Müəllim övladınızın uğur və çətinlikləri barədə sizə kifayət qədər məlumat verirmi?' },
    { id: 'q7', type: 'choice', options: ['Azdır', 'Normaldır', 'Çoxdur'], text: 'Ev tapşırıqlarının həcmi sizcə necədir?' },
    { id: 'q8', type: 'scale5', text: 'Dərslərin vaxtı və cədvəli sizin üçün rahatdırmı?' },
    { id: 'q9', type: 'nps', text: 'Kursumuzu dost və tanışlarınıza tövsiyə edərdinizmi? (0–10)' },
    { id: 'q10', type: 'text', optional: true, text: 'Təklif və iradlarınızı yazın.' }
  ]
};

// ===================== GİRİŞ NÖQTƏLƏRİ =====================
function doGet() {
  return json_({ ok: true, message: 'Aslan Lessons API işləyir.' });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'Sorğu düzgün deyil.' });
  }
  try {
    return json_(handle_(req));
  } catch (err) {
    if (err && err.userMsg) return json_({ ok: false, error: err.message, code: err.code || '' });
    console.error(err && err.stack ? err.stack : err);
    return json_({ ok: false, error: 'Serverdə xəta baş verdi: ' + (err && err.message ? err.message : err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Girişsiz (public) əməliyyatlar — valideyn linkləri
var PUBLIC = { publicCard: 1, publicSurveyInfo: 1, submitSurvey: 1, maintenanceStatus: 1 };

const ROUTES = {
  bootstrap:      { fn: function () { return {}; }, data: true },
  logout:         { fn: logout_, lock: true },
  setTheme:       { fn: setTheme_, lock: true },
  dismissInstall: { fn: dismissInstall_, lock: true },
  changePassword: { fn: changePassword_, lock: true },

  addStudent:     { fn: addStudent_, lock: true, data: true },
  editStudent:    { fn: editStudent_, lock: true, data: true },
  deleteStudent:  { fn: deleteStudent_, lock: true, data: true },
  getStudentCard: { fn: getStudentCard_, lock: true },
  studentLink:    { fn: studentLink_, lock: true },

  addUser:        { fn: addUser_, lock: true, data: true },
  editUser:       { fn: editUser_, lock: true, data: true },
  deleteUser:     { fn: deleteUser_, lock: true, data: true },
  revealPassword: { fn: revealPassword_, lock: true },

  addCourse:      { fn: addCourse_, lock: true, data: true },
  editCourse:     { fn: editCourse_, lock: true, data: true },
  deleteCourse:   { fn: deleteCourse_, lock: true, data: true },
  newMonth:       { fn: newMonth_, lock: true, data: true },
  transferStudent:{ fn: transferStudent_, lock: true, data: true },

  markLesson:     { fn: markLesson_, lock: true, data: true },
  editLesson:     { fn: editLesson_, lock: true, data: true },
  deleteLesson:   { fn: deleteLesson_, lock: true, data: true },
  getLessons:     { fn: getLessons_ },

  addPayment:     { fn: addPayment_, lock: true, data: true },
  deletePayment:  { fn: deletePayment_, lock: true, data: true },

  getLogs:        { fn: getLogs_ },
  getDevLog:      { fn: getDevLog_, lock: true },
  setPermissions: { fn: setPermissions_, lock: true, data: true },

  // Bildirişlər
  markNotif:      { fn: markNotif_, lock: true },
  markAllNotifs:  { fn: markAllNotifs_, lock: true },

  // Elanlar
  listAnns:       { fn: listAnns_ },
  saveAnn:        { fn: saveAnn_, lock: true },
  deleteAnn:      { fn: deleteAnn_, lock: true },
  dismissAnn:     { fn: dismissAnn_, lock: true },
  seenPopup:      { fn: seenPopup_, lock: true },

  // Sorğular
  surveyTargets:  { fn: surveyTargets_ },
  sendSurvey:     { fn: sendSurvey_, lock: true },
  surveyResponses:{ fn: surveyResponses_ },
  setSurveyStatus:{ fn: setSurveyStatus_, lock: true },
  getSurveyQuestions:{ fn: getSurveyQuestions_ },
  saveSurveyQuestions:{ fn: saveSurveyQuestions_, lock: true },

  // Alətlər
  trashList:      { fn: trashList_ },
  restoreItem:    { fn: restoreItem_, lock: true, data: true },
  purgeItem:      { fn: purgeItem_, lock: true, data: true },
  teacherLeave:   { fn: teacherLeave_, lock: true, data: true },
  moveStudents:   { fn: moveStudents_, lock: true, data: true },
  dataCheck:      { fn: dataCheck_ },

  // Yeniliklər
  listChangelog:  { fn: listChangelog_ },
  addChangelog:   { fn: addChangelog_, lock: true },
  deleteChangelog:{ fn: deleteChangelog_, lock: true },
  markNewsSeen:   { fn: markNewsSeen_, lock: true },

  // Developer
  setMaintenance: { fn: setMaintenance_, lock: true },
  devStats:       { fn: devStats_ },
  archivePreview: { fn: archivePreview_ },
  archiveNow:     { fn: archiveNow_, lock: true },
  archiveAutoNow: { fn: archiveAutoNow_, lock: true },
  archiveInfo:    { fn: archiveInfo_ },
  installTriggers:{ fn: installTriggersRoute_, lock: true },
  testDataInfo:   { fn: testDataInfo_ },
  genTestData:    { fn: genTestData_, lock: true },
  purgeTestData:  { fn: purgeTestData_, lock: true }
};

function handle_(req) {
  var action = String(req.action || '');

  // Public (girişsiz) əməliyyatlar — valideyn linkləri texniki iş zamanı da işləyir
  if (PUBLIC[action]) {
    if (action === 'maintenanceStatus') return { ok: true, maintenance: maint_() };
    return withLock_(function () {
      var fn = { publicCard: publicCard_, publicSurveyInfo: publicSurveyInfo_, submitSurvey: submitSurvey_ }[action];
      var res = fn(req) || {};
      res.ok = true;
      return res;
    });
  }

  if (action === 'login') return withLock_(function () { return login_(req); });

  var route = ROUTES[action];
  if (!route) throw fail_('Naməlum əməliyyat.');
  var user = auth_(req.token);

  // Texniki iş rejimi: developer işləyir; digərləri yalnız çıxış edə bilər, qalan əməliyyatlar bağlıdır
  if (maintOn_() && user.role !== 'developer' && action !== 'logout') {
    return { ok: false, code: 'MAINT', error: 'Sistemdə texniki işlər aparılır.', maintenance: maint_(),
      me: { id: user.id, name: user.name, role: user.role, theme: user.theme === 'dark' ? 'dark' : 'light' } };
  }

  var run = function () {
    var res;
    try {
      res = route.fn(user, req) || {};
    } catch (err) {
      if (err && err.code === 'PERM') log_(user, 'security', 'İcazəsiz əməliyyat cəhdi', 'Əməliyyat: ' + action + ' — ' + err.message);
      throw err;
    }
    var out = { ok: true };
    Object.keys(res).forEach(function (k) { out[k] = res[k]; });
    if (route.data) out.data = bootstrap_(findUser_(user.id) || user, req);
    return out;
  };
  return route.lock ? withLock_(run) : run();
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw fail_('Server hazırda məşğuldur. Bir neçə saniyədən sonra yenidən cəhd edin.');
  try {
    var res = fn();
    SpreadsheetApp.flush();
    return res;
  } finally {
    lock.releaseLock();
  }
}

function fail_(msg, code) {
  var e = new Error(msg);
  e.userMsg = true;
  e.code = code || '';
  return e;
}

// ===================== QURAŞDIRMA =====================
function setup() {
  Object.keys(SCHEMA).forEach(function (name) {
    var m = meta_(name);
    m.sh.getRange('A:' + colLetter_(m.head.length)).setNumberFormat('@');
  });
  var users = rawRows_('Users');
  var main = users.filter(function (u) { return u.role === 'superadmin'; })[0];
  if (!main) {
    if (users.some(function (u) { return lower_(u.login) === lower_(MAIN_ADMIN.login); })) {
      throw new Error('«' + MAIN_ADMIN.login + '» loginli istifadəçi artıq var. MAIN_ADMIN.login-i dəyişin.');
    }
    insertMany_('Users', [{
      id: newId_('U'), name: MAIN_ADMIN.name, login: MAIN_ADMIN.login, password: MAIN_ADMIN.password,
      role: 'superadmin', phone: '', permissions: '', theme: 'light', createdAt: now_(), updatedAt: '', deletedAt: '', deletedBy: ''
    }]);
    log_(null, 'system', 'Sistem quruldu', 'Baş admin yaradıldı. Login: ' + MAIN_ADMIN.login);
    Logger.log('Baş admin yaradıldı. Login: ' + MAIN_ADMIN.login + ' | Şifrə: ' + MAIN_ADMIN.password);
  }
  var dev = rawRows_('Users').filter(function (u) { return u.role === 'developer'; })[0];
  if (!dev) {
    if (rawRows_('Users').some(function (u) { return lower_(u.login) === lower_(DEVELOPER.login); })) {
      Logger.log('Developer logini məşğuldur, yaradılmadı.');
    } else {
      insertMany_('Users', [{
        id: newId_('U'), name: DEVELOPER.name, login: DEVELOPER.login, password: DEVELOPER.password,
        role: 'developer', phone: '', permissions: '', theme: 'light', createdAt: now_(), updatedAt: '', deletedAt: '', deletedBy: ''
      }]);
      log_(null, 'system', 'Sistem quruldu', 'Developer hesabı yaradıldı. Login: ' + DEVELOPER.login);
      Logger.log('Developer yaradıldı. Login: ' + DEVELOPER.login + ' | Şifrə: ' + DEVELOPER.password);
    }
  }
  if (!settingGet_('survey')) settingSet_('survey', DEFAULT_SURVEY);
  try {
    var created = installTriggers_();
    Logger.log(created.length ? 'Triggerlər quruldu: ' + created.join(', ') : 'Triggerlər artıq qurulub.');
  } catch (e) {
    Logger.log('Triggerləri qurmaq olmadı: ' + e.message + ' — Developer panelindən yenidən cəhd edin.');
  }
}

/** Lazım olan triggerləri yaradır (təkrar yaratmır). */
function installTriggers_() {
  var have = {};
  ScriptApp.getProjectTriggers().forEach(function (t) { have[t.getHandlerFunction()] = true; });
  var created = [];
  TRIGGERS.forEach(function (t) {
    if (!have[t.fn]) { t.make(ScriptApp.newTrigger(t.fn)).create(); created.push(t.fn); }
  });
  return created;
}
function triggersStatus_() {
  var have = {};
  try { ScriptApp.getProjectTriggers().forEach(function (t) { have[t.getHandlerFunction()] = true; }); }
  catch (e) { return TRIGGERS.map(function (t) { return { fn: t.fn, label: t.label, on: null }; }); }
  return TRIGGERS.map(function (t) { return { fn: t.fn, label: t.label, on: !!have[t.fn] }; });
}

/** Trigger üçün: köhnə zibili təmizləyir. */
function purgeTrashDaily() {
  withLock_(function () {
    Object.keys(SOFT).forEach(function (name) {
      var old = trashRows_(name).filter(function (r) { return ageHours_(r.deletedAt) > TRASH_DAYS * 24; });
      if (old.length) removeRows_(name, old.map(function (r) { return r._row; }));
    });
    SpreadsheetApp.flush();
  });
}

// ===================== CƏDVƏL QATI =====================
var _ss = null, _meta = {}, _raw = {};

function ss_() {
  if (_ss) return _ss;
  _ss = SPREADSHEET_URL ? SpreadsheetApp.openByUrl(SPREADSHEET_URL) : SpreadsheetApp.getActiveSpreadsheet();
  if (!_ss) throw fail_('Google Cədvəl tapılmadı. Code.gs faylında SPREADSHEET_URL-i yoxlayın.');
  return _ss;
}

function meta_(name) {
  if (_meta[name]) return _meta[name];
  var ss = ss_();
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var head = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  while (head.length && head[head.length - 1] === '') head.pop();
  var changed = false;
  SCHEMA[name].forEach(function (h) { if (head.indexOf(h) === -1) { head.push(h); changed = true; } });
  if (changed) {
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('A:' + colLetter_(head.length)).setNumberFormat('@');
  }
  _meta[name] = { sh: sh, head: head };
  return _meta[name];
}

function rawRows_(name) {
  if (_raw[name]) return _raw[name];
  var m = meta_(name);
  var last = m.sh.getLastRow();
  var out = [];
  if (last >= 2) {
    var vals = m.sh.getRange(2, 1, last - 1, m.head.length).getValues();
    for (var i = 0; i < vals.length; i++) {
      var o = { _row: i + 2 };
      for (var j = 0; j < m.head.length; j++) if (m.head[j]) o[m.head[j]] = cell_(vals[i][j]);
      var keyCol = m.head[0];
      if (o[keyCol] !== '' && o[keyCol] != null) out.push(o);
    }
  }
  _raw[name] = out;
  return out;
}

// Aktiv (silinməmiş) sətirlər
function rows_(name) {
  var all = rawRows_(name);
  if (!SOFT[name]) return all;
  return all.filter(function (r) { return !r.deletedAt; });
}
function trashRows_(name) {
  return rawRows_(name).filter(function (r) { return !!r.deletedAt; });
}

function insertMany_(name, objs) {
  if (!objs.length) return;
  var m = meta_(name);
  var data = objs.map(function (o) { return m.head.map(function (h) { return val_(o[h]); }); });
  var start = m.sh.getLastRow() + 1;
  var need = start + data.length - 1 - m.sh.getMaxRows();
  if (need > 0) m.sh.insertRowsAfter(m.sh.getMaxRows(), need + 20);
  m.sh.getRange(start, 1, data.length, m.head.length).setValues(data);
  delete _raw[name];
}

function update_(name, rowObj, changes) {
  var m = meta_(name);
  Object.keys(changes).forEach(function (k) { rowObj[k] = changes[k]; });
  m.sh.getRange(rowObj._row, 1, 1, m.head.length).setValues([m.head.map(function (h) { return val_(rowObj[h]); })]);
}

function removeRows_(name, nums) {
  if (!nums.length) return;
  var m = meta_(name);
  var s = nums.filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return b - a; });
  if (m.sh.getMaxRows() - s.length < 3) m.sh.insertRowsAfter(m.sh.getMaxRows(), 10);
  var i = 0;
  while (i < s.length) {
    var start = s[i], count = 1;
    while (i + count < s.length && s[i + count] === start - count) count++;
    m.sh.deleteRows(start - count + 1, count);
    i += count;
  }
  delete _raw[name];
}

function cell_(v) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (isNaN(v.getTime())) return '';
    var full = Utilities.formatDate(v, TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
    return /\s00:00:00$/.test(full) ? full.slice(0, 10) : full;
  }
  return String(v);
}
function val_(v) {
  if (v === null || v === undefined) return '';
  var s = String(v);
  if (/^=/.test(s)) s = "'" + s;
  return s;
}
function colLetter_(n) {
  var s = '';
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// ===================== AYARLAR (Settings) =====================
function settingGet_(key) {
  var r = rawRows_('Settings').filter(function (x) { return x.key === key; })[0];
  if (!r || r.value === '') return null;
  try { return JSON.parse(r.value); } catch (e) { return null; }
}
function settingSet_(key, obj) {
  var r = rawRows_('Settings').filter(function (x) { return x.key === key; })[0];
  var val = JSON.stringify(obj);
  if (r) update_('Settings', r, { value: val, updatedAt: now_() });
  else insertMany_('Settings', [{ key: key, value: val, updatedAt: now_() }]);
}
function maint_() { return settingGet_('maintenance') || { on: false }; }
function maintOn_() { return !!maint_().on; }

// ===================== KÖMƏKÇİLƏR =====================
function newId_(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function newToken_() { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''); }
function now_() { return Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss'); }
function today_() { return Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd'); }
function monthKey_() { return Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM'); }
function lower_(s) { return String(s || '').toLowerCase(); }
function fold_(s) {
  return String(s || '').toLocaleLowerCase('az')
    .replace(/ə/g, 'e').replace(/ı/g, 'i').replace(/i̇/g, 'i').replace(/ö/g, 'o').replace(/ü/g, 'u')
    .replace(/ç/g, 'c').replace(/ş/g, 's').replace(/ğ/g, 'g');
}
function digits_(s) { return String(s || '').replace(/\D/g, ''); }
function ageHours_(s) {
  if (!s) return Infinity;
  var t = new Date(String(s).replace(' ', 'T') + TZ_OFFSET).getTime();
  return isNaN(t) ? Infinity : (Date.now() - t) / 36e5;
}
function str_(v, max) { return String(v === null || v === undefined ? '' : v).trim().slice(0, max || 200); }
function reqStr_(v, label, min, max) {
  var s = str_(v, max);
  if (s.length < (min || 1)) throw fail_('«' + label + '» sahəsini doldurun' + (min > 1 ? ' (ən azı ' + min + ' simvol).' : '.'));
  return s;
}
function phone_(v, label) {
  var s = str_(v, 30);
  if (s && !/^[0-9+()\-\s]{5,25}$/.test(s)) throw fail_('«' + (label || 'Telefon') + '» düzgün deyil.');
  return s;
}
function date_(v) {
  var s = str_(v, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw fail_('Tarix düzgün deyil.');
  var d = new Date(s + 'T12:00:00' + TZ_OFFSET);
  if (isNaN(d.getTime()) || Utilities.formatDate(d, TIMEZONE, 'yyyy-MM-dd') !== s) throw fail_('Tarix düzgün deyil.');
  if (s > today_()) throw fail_('Gələcək tarixi seçmək olmaz.');
  return s;
}
function idList_(s) { return String(s || '').split(',').map(function (x) { return x.trim(); }).filter(String); }

function findUser_(id) { return rows_('Users').filter(function (x) { return x.id === String(id); })[0] || null; }
function findStudent_(id) { return rows_('Students').filter(function (x) { return x.id === String(id); })[0] || null; }
function findCourse_(id) { return rows_('Courses').filter(function (x) { return x.id === String(id); })[0] || null; }
function mustStudent_(id) { var s = findStudent_(id); if (!s) throw fail_('Tələbə tapılmadı. Səhifəni yeniləyin.'); return s; }
function mustCourse_(id) { var c = findCourse_(id); if (!c) throw fail_('Məşğələ tapılmadı. Səhifəni yeniləyin.'); return c; }
function mustUser_(id) { var u = findUser_(id); if (!u) throw fail_('İstifadəçi tapılmadı. Səhifəni yeniləyin.'); return u; }
function studentName_(id) { var s = findStudent_(id); return s ? s.name : '(silinmiş tələbə)'; }
function userName_(id) { var u = findUser_(id); return u ? u.name : (id ? '(silinmiş istifadəçi)' : '—'); }

function courseLabel_(c) {
  if (!c) return '(silinmiş məşğələ)';
  if (c.title) return c.title;
  var names = idList_(c.studentIds).map(studentName_);
  if (c.type === 'individual') return names[0] || 'Fərdi məşğələ';
  return names.slice(0, 2).join(', ') + (names.length > 2 ? ' +' + (names.length - 2) : '');
}
function courseLabelFrom_(c, sMap) {
  if (c.title) return c.title;
  var names = idList_(c.studentIds).map(function (id) { return sMap[id] ? sMap[id].name : '(silinmiş tələbə)'; });
  if (c.type === 'individual') return names[0] || 'Fərdi məşğələ';
  return names.slice(0, 2).join(', ') + (names.length > 2 ? ' +' + (names.length - 2) : '');
}

// ===================== İCAZƏLƏR =====================
function permsOf_(u) {
  if (!u) return [];
  if (u.role === 'superadmin') return ALL_PERMS.slice();
  if (u.role === 'developer') return [];
  var list = idList_(u.permissions).filter(function (k) { return ALL_PERMS.indexOf(k) !== -1; });
  return expandPerms_(list);
}
function expandPerms_(list) {
  var set = {};
  list.forEach(function (k) { set[k] = true; (IMPLIED[k] || []).forEach(function (x) { set[x] = true; }); });
  return ALL_PERMS.filter(function (k) { return set[k]; });
}
function can_(u, key) { return u.role === 'superadmin' || permsOf_(u).indexOf(key) !== -1; }
function need_(u, key) {
  if (!can_(u, key)) throw fail_('Bu əməliyyat üçün icazəniz yoxdur («' + PERM_LABEL[key] + '»).', 'PERM');
}

// ===================== JURNAL =====================
function log_(user, type, action, details) {
  var m = meta_('Logs');
  // Developer-in fəaliyyəti "dev" tipi ilə yazılır — adi jurnalda görünmür.
  var t = (user && user.role === 'developer' && type !== 'auth') ? 'dev' : type;
  var row = {
    id: newId_('L'), time: now_(),
    userId: user ? user.id : '', userName: user ? user.name : '—',
    role: user ? (ROLE_LABELS[user.role] || user.role) : '—',
    type: t, action: action, details: details || ''
  };
  m.sh.appendRow(m.head.map(function (h) { return val_(row[h]); }));
  delete _raw.Logs;
}

// ===================== BİLDİRİŞLƏR =====================
function notify_(userIds, type, text, page, param) {
  var seen = {}, rows = [];
  (userIds || []).forEach(function (id) {
    id = String(id || '');
    if (!id || seen[id]) return;
    seen[id] = true;
    rows.push({ id: newId_('N'), userId: id, type: type, text: text, page: page || '', param: param || '', createdAt: now_(), readAt: '' });
  });
  if (rows.length) insertMany_('Notifs', rows);
}
function adminsFor_(perm, exceptId) {
  return rows_('Users').filter(function (u) {
    if (u.id === exceptId) return false;
    if (u.role === 'developer') return false;
    return u.role === 'superadmin' || permsOf_(u).indexOf(perm) !== -1;
  }).map(function (u) { return u.id; });
}

// ===================== SESSİYA =====================
function auth_(token) {
  if (!token) throw fail_('Sessiya bitib. Yenidən daxil olun.', 'AUTH');
  var cache = CacheService.getScriptCache();
  var uid = cache.get('s_' + token);
  if (!uid) throw fail_('Sessiyanın vaxtı bitib. Yenidən daxil olun.', 'AUTH');
  var u = findUser_(uid);
  if (!u) { cache.remove('s_' + token); throw fail_('Hesabınız tapılmadı. Administratorla əlaqə saxlayın.', 'AUTH'); }
  cache.put('s_' + token, uid, SESSION_SECONDS);
  u._token = token;
  return u;
}

function login_(req) {
  var login = str_(req.login, 60);
  var pass = String(req.password || '');
  if (!login || !pass) throw fail_('Login və şifrəni daxil edin.');
  var cache = CacheService.getScriptCache();
  var key = 'f_' + lower_(login);
  var fails = Number(cache.get(key) || 0);
  if (fails >= MAX_LOGIN_FAILS) {
    log_(null, 'auth', 'Bloklanmış giriş cəhdi', 'Login: ' + login);
    throw fail_('Çoxlu uğursuz cəhd edildi. ' + LOGIN_LOCK_MINUTES + ' dəqiqədən sonra yenidən yoxlayın.');
  }
  var u = rows_('Users').filter(function (x) { return lower_(x.login) === lower_(login); })[0];
  if (!u || String(u.password) !== pass) {
    cache.put(key, String(fails + 1), LOGIN_LOCK_MINUTES * 60);
    log_(null, 'auth', 'Uğursuz giriş cəhdi', 'Login: ' + login + (u ? ' (şifrə yanlışdır)' : ' (belə login yoxdur)'));
    throw fail_('Login və ya şifrə yanlışdır.');
  }
  cache.remove(key);
  var token = newToken_();
  cache.put('s_' + token, u.id, SESSION_SECONDS);
  // Texniki iş zamanı da giriş mümkündür — istifadəçi daxil olur, amma məlumat yox, texniki iş ekranı görür
  if (maintOn_() && u.role !== 'developer') {
    log_(u, 'auth', 'Sistemə daxil oldu', 'Login: ' + u.login + ' · texniki iş rejimində');
    return { ok: true, token: token, maintenance: maint_(),
      me: { id: u.id, name: u.name, role: u.role, theme: u.theme === 'dark' ? 'dark' : 'light' } };
  }
  log_(u, 'auth', 'Sistemə daxil oldu', 'Login: ' + u.login);
  return { ok: true, token: token, data: bootstrap_(u, req) };
}

function dismissInstall_(u) {
  if (u.installHint !== 'dismissed') {
    update_('Users', u, { installHint: 'dismissed' });
    log_(u, 'profile', 'Ana ekrana əlavə et təklifini bağladı', '');
  }
  return {};
}

function logout_(u) {
  CacheService.getScriptCache().remove('s_' + u._token);
  log_(u, 'auth', 'Sistemdən çıxdı', '');
  return {};
}

function setTheme_(u, req) {
  var theme = req.theme === 'dark' ? 'dark' : 'light';
  if (u.theme !== theme) {
    update_('Users', u, { theme: theme });
    if (u.role !== 'developer') log_(u, 'profile', 'Görünüşü dəyişdi', theme === 'dark' ? 'Qaranlıq rejim' : 'İşıqlı rejim');
  }
  return { theme: theme };
}

function changePassword_(u, req) {
  if (String(req.oldPassword || '') !== String(u.password)) throw fail_('Hazırkı şifrə yanlışdır.');
  var np = String(req.newPassword || '');
  if (np.length < 4 || np.length > 50) throw fail_('Yeni şifrə 4–50 simvol olmalıdır.');
  if (/\s/.test(np)) throw fail_('Şifrədə boşluq olmamalıdır.');
  update_('Users', u, { password: np, updatedAt: now_() });
  log_(u, 'profile', 'Öz şifrəsini dəyişdi', '');
  return {};
}

// ===================== BOOTSTRAP =====================
function bootstrap_(u, req) {
  // Developer "müəllim gözü ilə" bax (yalnız oxu)
  var viewAs = null, real = null;
  if (u.role === 'developer' && req && req.viewAs) {
    var tgt = findUser_(req.viewAs);
    if (tgt && tgt.role !== 'developer') {
      real = u; viewAs = tgt;
      // yalnız baxış başlayanda qeyd et (avtomatik yeniləmələr jurnalı doldurmasın)
      if (req.viewAsStart) log_(u, 'dev', 'Müəllim gözü ilə baxış', tgt.name + ' (' + ROLE_LABELS[tgt.role] + ')');
      u = Object.assign({}, tgt, { _readOnly: true }); // yalnız oxu — heç bir qeyd düzəldilə bilməz
    }
  }

  var isDev = !viewAs && u.role === 'developer';
  var P = permsOf_(u);
  var has = function (k) { return P.indexOf(k) !== -1; };
  var isSuper = u.role === 'superadmin';
  var readOnly = !!viewAs;

  var base = {
    me: {
      id: u.id, name: u.name, login: u.login, role: u.role,
      phone: u.phone, theme: (viewAs ? real : u).theme === 'dark' ? 'dark' : 'light',
      perms: P, isSuper: isSuper, isDev: isDev,
      readOnly: readOnly,
      viewAs: viewAs ? { id: viewAs.id, name: viewAs.name, role: viewAs.role } : null,
      devName: real ? real.name : '',
      installHint: (real || u).installHint || ''
    },
    today: today_(), now: now_(), editWindowHours: EDIT_WINDOW_HOURS,
    maintenance: maint_(),
    changelogCount: rawRows_('Changelog').length,
    staleDays: STALE_DAYS
  };
  // Yeniliklər: bu istifadəçinin hələ açmadığı qeydlərin sayı (developer özü yazır — sayğac lazım deyil)
  var newsSeen = newsSeenAt_(viewAs || u);
  base.me.newsSeenAt = newsSeen;
  base.newsUnread = isDev ? 0 : rawRows_('Changelog').filter(function (c) { return c.createdAt > newsSeen; }).length;

  if (isDev) {
    // Developer app məlumatlarını görmür — yalnız öz paneli
    base.devPanel = {
      teachers: rows_('Users').filter(function (x) { return x.role === 'teacher' || x.role === 'helper' || x.role === 'superadmin'; })
        .map(function (x) { return { id: x.id, name: x.name, role: x.role, login: x.login }; })
        .sort(function (a, b) { return a.name.localeCompare(b.name, 'az'); })
    };
    return base;
  }

  var users = rows_('Users'), students = rows_('Students'), courses = rows_('Courses'), lessons = rows_('Lessons');
  var sMap = {}; students.forEach(function (s) { sMap[s.id] = s; });
  var uMap = {}; users.forEach(function (x) { uMap[x.id] = x; });
  var byCourse = {};
  lessons.forEach(function (l) { (byCourse[l.courseId] = byCourse[l.courseId] || []).push(l); });

  var visible = has('courses.view') ? courses : courses.filter(function (c) { return c.teacherId === u.id; });
  base.courses = visible.map(function (c) {
    var withLessons = c.teacherId === u.id || has('attendance.view') || has('attendance.mark');
    return courseView_(c, byCourse[c.id] || [], u, P, sMap, uMap, withLessons);
  });

  if (has('students.view')) {
    base.students = students.map(function (s) {
      var o = { id: s.id, name: s.name, phone: s.phone, parentName: s.parentName, parentPhone: s.parentPhone, note: s.note, createdAt: s.createdAt };
      if (isTrue_(s.isTest)) o.isTest = true;
      return o;
    });
  } else {
    var need = {};
    if (has('courses.add') || has('courses.edit') || has('tools.bulk')) students.forEach(function (s) { need[s.id] = true; });
    visible.forEach(function (c) { idList_(c.studentIds).forEach(function (id) { need[id] = true; }); });
    base.students = students.filter(function (s) { return need[s.id]; }).map(function (s) { return { id: s.id, name: s.name }; });
  }

  base.users = users.map(function (x) {
    var o = { id: x.id, name: x.name, role: x.role };
    var hide = (x.role === 'superadmin' || x.role === 'developer') && !isSuper;
    if (x.role === 'developer' && !isSuper) return null; // developer yalnız baş adminə görünür
    if (has('teachers.view') && !hide) { o.login = x.login; o.phone = x.phone; o.createdAt = x.createdAt; }
    if (isSuper && x.role !== 'superadmin' && x.role !== 'developer') o.permissions = permsOf_(x);
    if (isTrue_(x.isTest)) o.isTest = true;
    return o;
  }).filter(Boolean);

  // İcmal: ödəniş vəziyyəti, son 7 günün dərsləri, sorğu xəbərdarlıqları (yalnız icazəsi olanlara)
  if (has('payments.view')) base.pay = payStatus_(courses, students, lessons);
  if (has('courses.view')) base.stats = { lessons7: heldSince_(lessons, 7) };
  if (has('survey.view')) {
    var answered = rawRows_('Surveys').filter(function (sv) { return sv.status === 'answered' && (sv.adminStatus || 'new') === 'new'; });
    base.surveyAlerts = { fresh: answered.length, low: answered.filter(function (sv) { return sv.lowFlag === 'true'; }).length };
  }

  base.permCatalog = isSuper ? PERMISSIONS : [];
  base.permImplied = isSuper ? IMPLIED : {};

  // Bildirişlər
  var myNotifs = rawRows_('Notifs').filter(function (n) { return n.userId === u.id; })
    .sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
  base.notifs = myNotifs.slice(0, 40).map(function (n) {
    return { id: n.id, type: n.type, text: n.text, page: n.page, param: n.param, createdAt: n.createdAt, read: !!n.readAt };
  });
  base.notifUnread = myNotifs.filter(function (n) { return !n.readAt; }).length;

  // Elanlar: aktiv olanlar, bu istifadəçinin bağlamadıqları
  var seenRows = rawRows_('AnnSeen').filter(function (x) { return x.userId === u.id; });
  var seenMap = {}; seenRows.forEach(function (x) { seenMap[x.annId] = x; });
  var activeAnns = rawRows_('Anns').filter(function (a) { return a.active === 'true' || a.active === '1' || a.active === true; })
    .sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
  base.announcements = activeAnns.filter(function (a) { return !(seenMap[a.id] && seenMap[a.id].dismissedAt); })
    .map(function (a) { return { id: a.id, title: a.title, body: a.body, createdAt: a.createdAt, by: userName_(a.createdBy) }; });
  var popup = activeAnns.filter(function (a) { return (a.popup === 'true' || a.popup === '1') && !(seenMap[a.id] && seenMap[a.id].popupSeenAt); })[0];
  base.popupAnnouncement = popup ? { id: popup.id, title: popup.title, body: popup.body, by: userName_(popup.createdBy), createdAt: popup.createdAt } : null;

  // Sorğu xəbərdarlığı (göndərilə biləcək)
  base.flags = { announce: has('announce.send'), survey: has('survey.view') || has('survey.send') || has('survey.edit'),
    tools: has('tools.trash') || has('tools.bulk') || has('tools.datacheck') };

  return base;
}

function courseView_(c, rows, u, P, sMap, uMap, withLessons) {
  var N = Number(c.lessonsPerMonth) === 12 ? 12 : 8;
  var m = Number(c.monthNo) || 1;
  var ids = idList_(c.studentIds);
  var cur = rows.filter(function (r) { return Number(r.monthNo) === m; });
  var ev = events_(cur, u, P, sMap, uMap);
  var held = ev.filter(function (e) { return e.held; }).length;
  var per = {};
  ids.forEach(function (id) { per[id] = { held: 0, absent: 0 }; });
  var absent = 0;
  cur.forEach(function (r) {
    if (r.status === ABSENT) absent++;
    if (!per[r.studentId]) return;
    if (r.status === HELD) per[r.studentId].held++; else per[r.studentId].absent++;
  });
  var t = uMap[c.teacherId];
  return {
    id: c.id, title: c.title, type: c.type === 'group' ? 'group' : 'individual',
    teacherId: c.teacherId, teacherName: t ? t.name : '(silinmiş müəllim)',
    studentIds: ids, lessonsPerMonth: N, monthNo: m, monthStart: c.monthStart,
    createdAt: c.createdAt, updatedAt: c.updatedAt,
    held: held, absent: absent, complete: held >= N, perStudent: per,
    lastDate: ev.length ? ev[ev.length - 1].date : '',
    lessons: withLessons ? ev : null,
    isTest: isTrue_(c.isTest)
  };
}

function isTrue_(v) { return v === true || v === 'true' || v === '1' || v === 1; }

/**
 * Ödəniş vəziyyəti — qiymət saxlanılmadığı üçün «ay» əsasında hesablanır:
 *  · borc (d)  — tələbənin dərsdə iştirak etdiyi, artıq bağlanmış ay üçün ödəniş yazılmayıb
 *               (bağlanmış ay = məşğələ növbəti aya keçib, ya da tələbə artıq bu məşğələdə deyil);
 *  · gözlənilir (w) — məşğələnin cari ayı üçün ödəniş hələ yoxdur.
 * Yalnız problemi olan tələbələr qaytarılır: { studentId: { d: [[courseId, ay, keçdiyi dərs]], w: [[...]] } }.
 * Məşğələsiz («ümumi») ödənişlər heç bir aya aid edilmir.
 */
function payStatus_(courses, students, lessons) {
  var live = {}; students.forEach(function (s) { live[s.id] = true; });
  var cMap = {}; courses.forEach(function (c) { cMap[c.id] = c; });
  var paid = {};
  rows_('Payments').forEach(function (p) { if (p.courseId) paid[p.studentId + '|' + p.courseId + '|' + Number(p.monthNo || 0)] = true; });
  var held = {};
  lessons.forEach(function (l) {
    if (l.status !== HELD || !cMap[l.courseId] || !live[l.studentId]) return;
    var k = l.studentId + '|' + l.courseId + '|' + (Number(l.monthNo) || 1);
    held[k] = (held[k] || 0) + 1;
  });
  var out = {};
  var add = function (sid, kind, row) { var o = out[sid] || (out[sid] = { d: [], w: [] }); o[kind].push(row); };
  Object.keys(held).forEach(function (k) {
    if (paid[k]) return;
    var p = k.split('|'), c = cMap[p[1]], m = Number(p[2]);
    var inCourse = idList_(c.studentIds).indexOf(p[0]) !== -1;
    var cur = Number(c.monthNo) || 1;
    if (m < cur || !inCourse) add(p[0], 'd', [c.id, m, held[k]]);
  });
  courses.forEach(function (c) {
    var m = Number(c.monthNo) || 1;
    idList_(c.studentIds).forEach(function (sid) {
      if (!live[sid] || paid[sid + '|' + c.id + '|' + m]) return;
      add(sid, 'w', [c.id, m, held[sid + '|' + c.id + '|' + m] || 0]);
    });
  });
  Object.keys(out).forEach(function (sid) { out[sid].d.sort(function (a, b) { return a[1] - b[1]; }); });
  return out;
}

// Son N gündə keçirilmiş dərslərin sayı (qrup dərsi bir dərs sayılır)
function heldSince_(lessons, days) {
  var from = Utilities.formatDate(new Date(Date.now() - days * 864e5), TIMEZONE, 'yyyy-MM-dd');
  var seen = {};
  lessons.forEach(function (l) { if (l.status === HELD && l.date >= from) seen[l.lessonId] = true; });
  return Object.keys(seen).length;
}

// Yeniliklərin «oxundu» nöqtəsi: heç açmayıbsa — hesabın yaradılma vaxtı (yeni istifadəçiyə köhnə qeydlər «yeni» görünməsin)
function newsSeenAt_(u) { return String(u.newsSeenAt || u.createdAt || ''); }

function events_(rows, u, P, sMap, uMap) {
  var g = {}, order = [];
  rows.forEach(function (r) {
    if (!g[r.lessonId]) {
      g[r.lessonId] = {
        lessonId: r.lessonId, courseId: r.courseId, monthNo: Number(r.monthNo) || 1, date: r.date, topic: r.topic,
        markedBy: r.markedBy, markedByName: uMap[r.markedBy] ? uMap[r.markedBy].name : (r.markedBy ? '(silinmiş istifadəçi)' : '—'),
        markedAt: r.markedAt, editedBy: r.editedBy,
        editedByName: r.editedBy ? (uMap[r.editedBy] ? uMap[r.editedBy].name : '(silinmiş istifadəçi)') : '',
        editedAt: r.editedAt, entries: []
      };
      order.push(r.lessonId);
    }
    g[r.lessonId].entries.push({
      studentId: r.studentId,
      studentName: sMap[r.studentId] ? sMap[r.studentId].name : '(silinmiş tələbə)',
      status: r.status === HELD ? HELD : ABSENT, reason: r.reason
    });
  });
  var list = order.map(function (k) { return g[k]; });
  list.forEach(function (e) { e.held = e.entries.some(function (x) { return x.status === HELD; }); });
  list.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.markedAt < b.markedAt ? -1 : (a.markedAt > b.markedAt ? 1 : 0);
  });
  var cnt = {};
  var ro = u._readOnly;
  list.forEach(function (e) {
    var k = e.courseId + '|' + e.monthNo;
    if (e.held) { cnt[k] = (cnt[k] || 0) + 1; e.no = cnt[k]; } else e.no = null;
    var age = ageHours_(e.markedAt);
    var own = e.markedBy === u.id && age < EDIT_WINDOW_HOURS;
    e.canEdit = !ro && (P.indexOf('attendance.edit') !== -1 || own);
    e.canDelete = !ro && (P.indexOf('attendance.delete') !== -1 || own);
    e.editHoursLeft = e.markedBy === u.id && age < EDIT_WINDOW_HOURS ? Math.max(0, Math.round((EDIT_WINDOW_HOURS - age) * 10) / 10) : null;
  });
  return list;
}

// ===================== TƏLƏBƏLƏR =====================
function studentPayload_(req) {
  return {
    name: reqStr_(req.name, 'Ad Soyad', 2, 80),
    phone: phone_(req.phone, 'Telefon'),
    parentName: str_(req.parentName, 80),
    parentPhone: phone_(req.parentPhone, 'Valideynin telefonu'),
    note: str_(req.note, 500)
  };
}
function diffText_(oldObj, newObj, labels) {
  var out = [];
  Object.keys(labels).forEach(function (k) {
    if (!(k in newObj)) return;
    var a = String(oldObj[k] || ''), b = String(newObj[k] || '');
    if (a !== b) out.push(labels[k] + ': «' + (a || '—') + '» → «' + (b || '—') + '»');
  });
  return out.join('; ');
}

function dupStudents_(name, phone, exceptId) {
  var fn = fold_(name), dp = digits_(phone);
  return rows_('Students').filter(function (s) {
    if (exceptId && s.id === exceptId) return false;
    if (fold_(s.name) === fn) return true;
    if (dp && dp.length >= 7 && digits_(s.phone) === dp) return true;
    return false;
  });
}

function addStudent_(u, req) {
  need_(u, 'students.add');
  var p = studentPayload_(req);
  if (!req.force) {
    var dups = dupStudents_(p.name, p.phone, null);
    if (dups.length) {
      throw fail_('Belə tələbə artıq var: ' + dups.map(function (d) { return d.name + (d.phone ? ' (' + d.phone + ')' : ''); }).join(', ') +
        '. Yenə də əlavə edilsin?', 'DUP');
    }
  }
  var s = { id: newId_('S'), cardToken: newToken_(), status: 'active', createdAt: now_(), updatedAt: '', deletedAt: '', deletedBy: '' };
  Object.keys(p).forEach(function (k) { s[k] = p[k]; });
  insertMany_('Students', [s]);
  log_(u, 'student', 'Tələbə əlavə etdi', s.name + (s.phone ? ' · Tel: ' + s.phone : '') + (s.parentName ? ' · Valideyn: ' + s.parentName : ''));
  return { id: s.id };
}

function editStudent_(u, req) {
  need_(u, 'students.edit');
  var s = mustStudent_(req.id);
  var p = studentPayload_(req);
  var oldName = s.name;
  var diff = diffText_(s, p, STUDENT_FIELDS);
  p.updatedAt = now_();
  update_('Students', s, p);
  log_(u, 'student', 'Tələbəni redaktə etdi', oldName + ' — ' + (diff || 'dəyişiklik edilmədi'));
  return { id: s.id };
}

function deleteStudent_(u, req) {
  need_(u, 'students.delete');
  var s = mustStudent_(req.id);
  var inCourses = rows_('Courses').filter(function (c) { return idList_(c.studentIds).indexOf(s.id) !== -1; });
  if (inCourses.length) {
    throw fail_('Bu tələbə ' + inCourses.length + ' məşğələdə iştirak edir: ' + inCourses.map(courseLabel_).join(', ') +
      '. Əvvəlcə onu məşğələlərdən çıxarın və ya həmin məşğələləri silin.');
  }
  update_('Students', s, { deletedAt: now_(), deletedBy: u.id });
  log_(u, 'student', 'Tələbəni sildi', s.name + (s.phone ? ' · Tel: ' + s.phone : '') + ' · Zibil qutusuna köçürüldü');
  return {};
}

function studentLink_(u, req) {
  need_(u, 'students.view');
  var s = mustStudent_(req.id);
  if (!s.cardToken) { update_('Students', s, { cardToken: newToken_() }); }
  return { token: s.cardToken, name: s.name, parentPhone: s.parentPhone };
}

function monthlySeries_(history) {
  var by = {};
  history.forEach(function (h) {
    var k = String(h.monthNo || 1);
    if (!by[k]) by[k] = { monthNo: Number(k), held: 0, absent: 0 };
    if (h.status === HELD) by[k].held++; else by[k].absent++;
  });
  return Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return a.monthNo - b.monthNo; });
}

function buildCard_(s, u, forPublic) {
  var P = forPublic ? ALL_PERMS.slice() : permsOf_(u);
  var users = rows_('Users'), students = rows_('Students'), courses = rows_('Courses'), lessons = rows_('Lessons');
  var sMap = {}; students.forEach(function (x) { sMap[x.id] = x; });
  var uMap = {}; users.forEach(function (x) { uMap[x.id] = x; });
  var cMap = {}; courses.forEach(function (c) { cMap[c.id] = c; });
  var viewer = forPublic ? { id: '', role: 'public', _readOnly: true } : u;

  var myCourses = courses.filter(function (c) { return idList_(c.studentIds).indexOf(s.id) !== -1; });
  var touched = {};
  lessons.forEach(function (l) { if (l.studentId === s.id) touched[l.courseId] = true; });
  myCourses.forEach(function (c) { touched[c.id] = true; });
  var byCourse = {};
  lessons.forEach(function (l) { if (touched[l.courseId]) (byCourse[l.courseId] = byCourse[l.courseId] || []).push(l); });

  var history = [];
  Object.keys(byCourse).forEach(function (cid) {
    var c = cMap[cid];
    events_(byCourse[cid], viewer, P, sMap, uMap).forEach(function (e) {
      var mine = e.entries.filter(function (x) { return x.studentId === s.id; })[0];
      if (!mine) return;
      history.push({
        lessonId: e.lessonId, courseId: cid, courseExists: !!c,
        courseTitle: c ? courseLabelFrom_(c, sMap) : '(silinmiş məşğələ)', courseType: c ? c.type : '',
        teacherName: c && uMap[c.teacherId] ? uMap[c.teacherId].name : '—',
        monthNo: e.monthNo, no: e.no, date: e.date, topic: e.topic, status: mine.status, reason: mine.reason,
        markedByName: e.markedByName, markedAt: e.markedAt, editedByName: e.editedByName, editedAt: e.editedAt,
        canEdit: !forPublic && e.canEdit && !!c, canDelete: !forPublic && e.canDelete, groupSize: e.entries.length
      });
    });
  });
  history.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.markedAt < b.markedAt ? 1 : -1;
  });

  var courseViews = myCourses.map(function (c) {
    var v = courseView_(c, byCourse[c.id] || [], viewer, P, sMap, uMap, false);
    v.mine = v.perStudent[s.id] || { held: 0, absent: 0 };
    v.studentNames = v.studentIds.map(function (id) { return sMap[id] ? sMap[id].name : '(silinmiş tələbə)'; });
    return v;
  });

  var payments = null, total = 0;
  if (forPublic || P.indexOf('payments.view') !== -1) {
    payments = rows_('Payments').filter(function (p) { return p.studentId === s.id; }).map(function (p) {
      total += Number(p.amount) || 0;
      return {
        id: p.id, amount: Number(p.amount) || 0, date: p.date, note: p.note, monthNo: p.monthNo,
        courseId: p.courseId, courseTitle: p.courseId ? (cMap[p.courseId] ? courseLabelFrom_(cMap[p.courseId], sMap) : '(silinmiş məşğələ)') : '',
        createdByName: forPublic ? '' : (uMap[p.createdBy] ? uMap[p.createdBy].name : '—'), createdAt: p.createdAt
      };
    }).sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : (a.createdAt < b.createdAt ? 1 : -1)); });
  }

  return {
    student: forPublic
      ? { name: s.name }
      : { id: s.id, name: s.name, phone: s.phone, parentName: s.parentName, parentPhone: s.parentPhone, note: s.note, createdAt: s.createdAt },
    courses: courseViews, history: history,
    stats: {
      held: history.filter(function (h) { return h.status === HELD; }).length,
      absent: history.filter(function (h) { return h.status === ABSENT; }).length
    },
    monthly: monthlySeries_(history),
    transfers: forPublic ? [] : transfersOf_(s.id, sMap, uMap),
    payments: payments, paymentsTotal: Math.round(total * 100) / 100
  };
}

// Tələbənin qruplar arası köçürmə tarixçəsi (silinmiş məşğələlərin adları da göstərilir)
function transfersOf_(studentId, sMap, uMap) {
  var allC = {}; rawRows_('Courses').forEach(function (c) { allC[c.id] = c; });
  var label = function (id) {
    var c = allC[id];
    if (!c) return '(silinmiş məşğələ)';
    return courseLabelFrom_(c, sMap) + (c.deletedAt ? ' (silinib)' : '');
  };
  return rows_('Transfers').filter(function (t) { return t.studentId === studentId; }).map(function (t) {
    return { at: t.at, from: label(t.fromCourseId), to: label(t.toCourseId), by: uMap[t.byUser] ? uMap[t.byUser].name : '—', note: t.note };
  }).sort(function (a, b) { return a.at < b.at ? 1 : -1; });
}

function getStudentCard_(u, req) {
  need_(u, 'students.view');
  var s = mustStudent_(req.id);
  log_(u, 'view', 'Tələbə kartına baxdı', s.name);
  return { card: buildCard_(s, u, false) };
}

// ===================== İSTİFADƏÇİLƏR =====================
function userPayload_(req, isNew, target) {
  var p = {};
  p.name = reqStr_(req.name, 'Ad Soyad', 2, 80);
  p.login = str_(req.login, 30);
  if (!/^[A-Za-z0-9._-]{3,30}$/.test(p.login)) {
    throw fail_('Login 3–30 simvol olmalı və yalnız latın hərfləri, rəqəmlər, nöqtə, alt xətt və ya tire daxil etməlidir.');
  }
  var dup = rawRows_('Users').filter(function (x) { return lower_(x.login) === lower_(p.login) && !x.deletedAt && (!target || x.id !== target.id); })[0];
  if (dup) throw fail_('«' + p.login + '» logini artıq istifadə olunur.');
  var pw = String(req.password || '');
  if (isNew || pw) {
    if (pw.length < 4 || pw.length > 50) throw fail_('Şifrə 4–50 simvol olmalıdır.');
    if (/\s/.test(pw)) throw fail_('Şifrədə boşluq olmamalıdır.');
    p.password = pw;
  }
  p.phone = phone_(req.phone, 'Telefon');
  return p;
}

function addUser_(u, req) {
  need_(u, 'teachers.add');
  var role = req.role === 'helper' ? 'helper' : 'teacher';
  var p = userPayload_(req, true, null);
  var row = { id: newId_('U'), role: role, permissions: '', theme: 'light', createdAt: now_(), updatedAt: '', deletedAt: '', deletedBy: '' };
  Object.keys(p).forEach(function (k) { row[k] = p[k]; });
  insertMany_('Users', [row]);
  log_(u, 'teacher', role === 'helper' ? 'Yeni köməkçi əlavə etdi' : 'Yeni müəllim əlavə etdi',
    row.name + ' · Login: ' + row.login + (row.phone ? ' · Tel: ' + row.phone : ''));
  return { id: row.id };
}

function editUser_(u, req) {
  var t = mustUser_(req.id);
  if (t.role === 'superadmin' || t.role === 'developer') {
    if (u.id !== t.id) throw fail_('Bu hesabı yalnız özü redaktə edə bilər.', 'PERM');
  } else {
    need_(u, 'teachers.edit');
  }
  var p = userPayload_(req, false, t);
  var newRole = t.role;
  if (t.role === 'teacher' || t.role === 'helper') {
    newRole = req.role === 'helper' ? 'helper' : 'teacher';
    if (newRole === 'helper' && t.role === 'teacher') {
      var cs = rows_('Courses').filter(function (c) { return c.teacherId === t.id; });
      if (cs.length) throw fail_('Bu müəllimin ' + cs.length + ' məşğələsi var. Köməkçi etməzdən əvvəl məşğələləri başqa müəllimə verin.');
    }
  }
  var changes = [];
  var d = diffText_(t, p, { name: 'Ad Soyad', login: 'Login', phone: 'Telefon' });
  if (d) changes.push(d);
  if (newRole !== t.role) changes.push('Rol: «' + ROLE_LABELS[t.role] + '» → «' + ROLE_LABELS[newRole] + '»');
  if (p.password && p.password !== t.password) changes.push('Şifrə dəyişdirildi');
  var oldName = t.name;
  p.role = newRole;
  p.updatedAt = now_();
  update_('Users', t, p);
  var title = (t.role === 'superadmin' || t.role === 'developer') ? 'Öz profilini redaktə etdi' : (newRole === 'helper' ? 'Köməkçini redaktə etdi' : 'Müəllimi redaktə etdi');
  log_(u, 'teacher', title, oldName + ' — ' + (changes.join('; ') || 'dəyişiklik edilmədi'));
  return { id: t.id };
}

function deleteUser_(u, req) {
  need_(u, 'teachers.delete');
  var t = mustUser_(req.id);
  if (t.role === 'superadmin') throw fail_('Baş admini silmək olmaz.', 'PERM');
  if (t.role === 'developer') throw fail_('Developer hesabını silmək olmaz.', 'PERM');
  if (t.id === u.id) throw fail_('Öz hesabınızı silə bilməzsiniz.');
  var cs = rows_('Courses').filter(function (c) { return c.teacherId === t.id; });
  if (cs.length) {
    throw fail_('Bu müəllimin ' + cs.length + ' məşğələsi var: ' + cs.map(courseLabel_).join(', ') +
      '. Əvvəlcə «Alətlər»də məşğələləri başqa müəllimə verin və ya silin.');
  }
  update_('Users', t, { deletedAt: now_(), deletedBy: u.id });
  log_(u, 'teacher', t.role === 'helper' ? 'Köməkçini sildi' : 'Müəllimi sildi', t.name + ' · Login: ' + t.login + ' · Zibil qutusuna köçürüldü');
  return {};
}

function revealPassword_(u, req) {
  need_(u, 'teachers.passwords');
  var t = mustUser_(req.id);
  if ((t.role === 'superadmin' || t.role === 'developer') && u.role !== 'superadmin') throw fail_('Bu hesabın şifrəsinə baxmaq olmaz.', 'PERM');
  if (t.role === 'developer') throw fail_('Developer şifrəsinə baxmaq olmaz.', 'PERM');
  log_(u, 'security', 'Şifrəyə baxdı', t.name + ' (' + ROLE_LABELS[t.role] + ')');
  return { password: t.password };
}

// ===================== MƏŞĞƏLƏLƏR =====================
function coursePayload_(req) {
  var type = req.type === 'group' ? 'group' : (req.type === 'individual' ? 'individual' : '');
  if (!type) throw fail_('Məşğələnin növünü seçin.');
  var teacher = findUser_(req.teacherId);
  if (!teacher || (teacher.role !== 'teacher' && teacher.role !== 'superadmin')) throw fail_('Müəllim seçin.');
  var ids = (Array.isArray(req.studentIds) ? req.studentIds : []).map(String).filter(function (v, i, a) { return v && a.indexOf(v) === i; });
  ids.forEach(function (id) { if (!findStudent_(id)) throw fail_('Seçilmiş tələbələrdən biri tapılmadı. Səhifəni yeniləyin.'); });
  if (type === 'individual' && ids.length !== 1) throw fail_('Fərdi məşğələ üçün bir tələbə seçin.');
  if (type === 'group' && ids.length < 2) throw fail_('Qrup məşğələsi üçün ən azı iki tələbə seçin.');
  var N = Number(req.lessonsPerMonth);
  if (N !== 8 && N !== 12) throw fail_('Aylıq dərs sayı 8 və ya 12 olmalıdır.');
  return { type: type, title: str_(req.title, 80), teacherId: teacher.id, studentIds: ids.join(','), lessonsPerMonth: String(N) };
}

function addCourse_(u, req) {
  need_(u, 'courses.add');
  var p = coursePayload_(req);
  var c = { id: newId_('C'), monthNo: '1', monthStart: today_(), createdAt: now_(), updatedAt: '', deletedAt: '', deletedBy: '' };
  Object.keys(p).forEach(function (k) { c[k] = p[k]; });
  insertMany_('Courses', [c]);
  log_(u, 'course', TYPE_LABELS[c.type] + ' məşğələ yaratdı',
    '«' + courseLabel_(c) + '» · Müəllim: ' + userName_(c.teacherId) + ' · Tələbə' + (c.type === 'group' ? 'lər' : '') + ': ' +
    idList_(c.studentIds).map(studentName_).join(', ') + ' · Ayda ' + c.lessonsPerMonth + ' dərs');
  if (c.teacherId !== u.id) notify_([c.teacherId], 'course', 'Sizə yeni məşğələ təyin edildi: «' + courseLabel_(c) + '»', 'mine', '');
  return { id: c.id };
}

function editCourse_(u, req) {
  need_(u, 'courses.edit');
  var c = mustCourse_(req.id);
  var p = coursePayload_(req);
  var label = courseLabel_(c);
  var ch = [];
  if (c.type !== p.type) ch.push('Növ: ' + TYPE_LABELS[c.type] + ' → ' + TYPE_LABELS[p.type]);
  if (String(c.title || '') !== p.title) ch.push('Ad: «' + (c.title || '—') + '» → «' + (p.title || '—') + '»');
  var teacherChanged = c.teacherId !== p.teacherId;
  if (teacherChanged) ch.push('Müəllim: ' + userName_(c.teacherId) + ' → ' + userName_(p.teacherId));
  var oldIds = idList_(c.studentIds), newIds = idList_(p.studentIds);
  var added = newIds.filter(function (x) { return oldIds.indexOf(x) === -1; });
  var removed = oldIds.filter(function (x) { return newIds.indexOf(x) === -1; });
  if (added.length) ch.push('Əlavə edilən tələbələr: ' + added.map(studentName_).join(', '));
  if (removed.length) ch.push('Çıxarılan tələbələr: ' + removed.map(studentName_).join(', '));
  if (String(c.lessonsPerMonth) !== p.lessonsPerMonth) ch.push('Aylıq dərs sayı: ' + c.lessonsPerMonth + ' → ' + p.lessonsPerMonth);
  var oldTeacher = c.teacherId;
  p.updatedAt = now_();
  update_('Courses', c, p);
  log_(u, 'course', 'Məşğələni redaktə etdi', '«' + label + '» — ' + (ch.join('; ') || 'dəyişiklik edilmədi'));
  if (teacherChanged) {
    if (p.teacherId !== u.id) notify_([p.teacherId], 'course', 'Sizə yeni məşğələ təyin edildi: «' + courseLabel_(c) + '»', 'mine', '');
    if (oldTeacher && oldTeacher !== u.id) notify_([oldTeacher], 'course', '«' + label + '» məşğələsi başqa müəlliməyə verildi.', 'mine', '');
  }
  return { id: c.id };
}

function deleteCourse_(u, req) {
  need_(u, 'courses.delete');
  var c = mustCourse_(req.id);
  var label = courseLabel_(c);
  update_('Courses', c, { deletedAt: now_(), deletedBy: u.id });
  log_(u, 'course', 'Məşğələni sildi',
    '«' + label + '» (' + TYPE_LABELS[c.type] + ') · Müəllim: ' + userName_(c.teacherId) + ' · Zibil qutusuna köçürüldü');
  if (c.teacherId && c.teacherId !== u.id) notify_([c.teacherId], 'course', '«' + label + '» məşğələsi silindi.', 'mine', '');
  return {};
}

function newMonth_(u, req) {
  need_(u, 'month.new');
  var c = mustCourse_(req.id);
  var m = Number(c.monthNo) || 1;
  var held = heldIn_(c.id, m, null);
  update_('Courses', c, { monthNo: String(m + 1), monthStart: today_(), updatedAt: now_() });
  log_(u, 'month', 'Yeni ay başlatdı', '«' + courseLabel_(c) + '» · Ay ' + m + ' → Ay ' + (m + 1) + ' · Bitən ayda keçirilən dərslər: ' + held + '/' + c.lessonsPerMonth);
  if (c.teacherId && c.teacherId !== u.id) notify_([c.teacherId], 'month', '«' + courseLabel_(c) + '» üçün yeni ay (ay ' + (m + 1) + ') başladıldı.', 'mine', '');
  return {};
}

function transferStudent_(u, req) {
  need_(u, 'tools.bulk');
  var s = mustStudent_(req.studentId);
  var from = mustCourse_(req.fromCourseId);
  var to = mustCourse_(req.toCourseId);
  if (from.id === to.id) throw fail_('Mənbə və hədəf məşğələ eyni ola bilməz.');
  var fromIds = idList_(from.studentIds), toIds = idList_(to.studentIds);
  if (fromIds.indexOf(s.id) === -1) throw fail_('Tələbə mənbə məşğələdə yoxdur.');
  if (toIds.indexOf(s.id) !== -1) throw fail_('Tələbə artıq hədəf məşğələdədir.');
  if (from.type === 'individual') throw fail_('Fərdi məşğələdən köçürmə olmaz. Fərdi məşğələni redaktə edin.');
  if (fromIds.length - 1 < 2) throw fail_('Köçürmədən sonra mənbə qrupda 2-dən az tələbə qalır. Əvvəlcə qrupu redaktə edin və ya bağlayın.');
  if (to.type === 'individual') throw fail_('Fərdi məşğələyə əlavə etmək olmaz.');
  var note = str_(req.note, 200);
  update_('Courses', from, { studentIds: fromIds.filter(function (x) { return x !== s.id; }).join(','), updatedAt: now_() });
  update_('Courses', to, { studentIds: toIds.concat([s.id]).join(','), updatedAt: now_() });
  insertMany_('Transfers', [{ id: newId_('T'), studentId: s.id, fromCourseId: from.id, toCourseId: to.id, byUser: u.id, at: now_(), note: note }]);
  log_(u, 'transfer', 'Tələbəni köçürdü', s.name + ': «' + courseLabel_(from) + '» → «' + courseLabel_(to) + '»' + (note ? ' · ' + note : ''));
  var who = [];
  if (from.teacherId && from.teacherId !== u.id) who.push(from.teacherId);
  if (to.teacherId && to.teacherId !== u.id && to.teacherId !== from.teacherId) who.push(to.teacherId);
  notify_(who, 'transfer', s.name + ' tələbəsi «' + courseLabel_(from) + '» ↔ «' + courseLabel_(to) + '» köçürüldü.', 'mine', '');
  return {};
}

// ===================== DƏRS QEYDLƏRİ =====================
function normEntries_(entries, ids) {
  var map = {};
  (Array.isArray(entries) ? entries : []).forEach(function (e) { if (e && e.studentId) map[String(e.studentId)] = e; });
  Object.keys(map).forEach(function (k) { if (ids.indexOf(k) === -1) throw fail_('Siyahıda məşğələyə aid olmayan tələbə var. Səhifəni yeniləyin.'); });
  return ids.map(function (id) {
    var e = map[id];
    if (!e) throw fail_('Bütün tələbələr üçün qeyd seçin. Səhifəni yeniləyin.');
    var status = e.status === HELD ? HELD : (e.status === ABSENT ? ABSENT : '');
    if (!status) throw fail_('Qeyd növü düzgün deyil.');
    var reason = status === ABSENT ? str_(e.reason, 300) : '';
    if (status === ABSENT && !reason) throw fail_('Qayıb üçün səbəb yazın: ' + studentName_(id) + '.');
    return { studentId: id, status: status, reason: reason };
  });
}
function heldIn_(courseId, monthNo, exceptLessonId) {
  var set = {};
  rows_('Lessons').forEach(function (l) {
    if (l.courseId === courseId && Number(l.monthNo) === Number(monthNo) && l.status === HELD && l.lessonId !== exceptLessonId) set[l.lessonId] = true;
  });
  return Object.keys(set).length;
}
function entriesText_(entries) {
  return entries.map(function (e) { return studentName_(e.studentId) + ': ' + e.status + (e.reason ? ' (' + e.reason + ')' : ''); }).join('; ');
}

function markLesson_(u, req) {
  var c = mustCourse_(req.courseId);
  if (c.teacherId !== u.id && !can_(u, 'attendance.mark')) throw fail_('Bu məşğələdə dərs qeyd etmək üçün icazəniz yoxdur.', 'PERM');
  var date = date_(req.date);
  var topic = str_(req.topic, 200);
  var ids = idList_(c.studentIds);
  if (!ids.length) throw fail_('Məşğələdə tələbə yoxdur.');
  var entries = normEntries_(req.entries, ids);
  var N = Number(c.lessonsPerMonth) || 8;
  var m = Number(c.monthNo) || 1;
  var held = heldIn_(c.id, m, null);
  if (held >= N) throw fail_('Bu ayın bütün dərsləri (' + N + '/' + N + ') artıq qeyd olunub. Tələbə davam edirsə, admin yeni ay başlatmalıdır.');
  var isHeld = entries.some(function (e) { return e.status === HELD; });
  var lessonId = newId_('D');
  var stamp = now_();
  insertMany_('Lessons', entries.map(function (e) {
    return { id: newId_('A'), lessonId: lessonId, courseId: c.id, monthNo: String(m), date: date,
      studentId: e.studentId, status: e.status, reason: e.reason, topic: topic, markedBy: u.id, markedAt: stamp, editedBy: '', editedAt: '' };
  }));
  var action = isHeld ? 'Dərsi keçirilmiş kimi qeyd etdi' : 'Dərsi qayıb kimi qeyd etdi';
  var complete = isHeld && held + 1 >= N;
  log_(u, 'lesson', action,
    '«' + courseLabel_(c) + '» · Ay ' + m + ' · Tarix: ' + date + ' · ' + (isHeld ? 'Keçirilən dərslər: ' + (held + 1) + '/' + N : 'Dərs sayına daxil edilmədi') +
    (topic ? ' · Mövzu: ' + topic : '') + ' · ' + entriesText_(entries));
  if (complete) notify_(adminsFor_('month.new', u.id), 'complete', '«' + courseLabel_(c) + '» məşğələsi ' + N + '/' + N + ' oldu — yeni ay başlatmaq lazımdır.', 'courses', '');
  return { lessonId: lessonId, complete: complete };
}

function lessonRows_(lessonId) {
  var rows = rows_('Lessons').filter(function (l) { return l.lessonId === String(lessonId); });
  if (!rows.length) throw fail_('Dərs qeydi tapılmadı. Səhifəni yeniləyin.');
  return rows;
}
function canTouchLesson_(u, rows, permKey) {
  if (can_(u, permKey)) return true;
  var r = rows[0];
  return r.markedBy === u.id && ageHours_(r.markedAt) < EDIT_WINDOW_HOURS;
}

function editLesson_(u, req) {
  var rows = lessonRows_(req.lessonId);
  if (!canTouchLesson_(u, rows, 'attendance.edit')) throw fail_('Qeydi düzəltmək üçün vaxt (' + EDIT_WINDOW_HOURS + ' saat) bitib. Düzəliş üçün adminə müraciət edin.', 'PERM');
  var c = findCourse_(rows[0].courseId);
  if (!c) throw fail_('Bu qeydin aid olduğu məşğələ silinib.');
  var ids = rows.map(function (r) { return r.studentId; });
  var date = date_(req.date);
  var topic = str_(req.topic, 200);
  var entries = normEntries_(req.entries, ids);
  var wasHeld = rows.some(function (r) { return r.status === HELD; });
  var isHeld = entries.some(function (e) { return e.status === HELD; });
  var m = Number(rows[0].monthNo) || 1;
  var N = Number(c.lessonsPerMonth) || 8;
  if (isHeld && !wasHeld && heldIn_(c.id, m, rows[0].lessonId) >= N) throw fail_('Bu ayın bütün dərsləri (' + N + '/' + N + ') artıq qeyd olunub. Bu qeydi «keçdi» etmək olmaz.');
  var before = 'Tarix: ' + rows[0].date + (rows[0].topic ? ', Mövzu: ' + rows[0].topic : '') + ', ' +
    entriesText_(rows.map(function (r) { return { studentId: r.studentId, status: r.status, reason: r.reason }; }));
  var stamp = now_();
  var byId = {};
  entries.forEach(function (e) { byId[e.studentId] = e; });
  var markedBy = rows[0].markedBy;
  rows.forEach(function (r) {
    var e = byId[r.studentId];
    update_('Lessons', r, { date: date, topic: topic, status: e.status, reason: e.reason, editedBy: u.id, editedAt: stamp });
  });
  var after = 'Tarix: ' + date + (topic ? ', Mövzu: ' + topic : '') + ', ' + entriesText_(entries);
  log_(u, 'lesson', 'Dərs qeydini düzəltdi', '«' + courseLabel_(c) + '» · Ay ' + m + ' · Əvvəl: [' + before + '] → Sonra: [' + after + ']');
  if (markedBy && markedBy !== u.id) notify_([markedBy], 'lesson', 'Admin «' + courseLabel_(c) + '» üzrə sizin dərs qeydinizi düzəltdi (' + fmtD_(date) + ').', 'mine', '');
  return {};
}

function deleteLesson_(u, req) {
  var rows = lessonRows_(req.lessonId);
  if (!canTouchLesson_(u, rows, 'attendance.delete')) throw fail_('Qeydi silmək üçün vaxt (' + EDIT_WINDOW_HOURS + ' saat) bitib. Silmək üçün adminə müraciət edin.', 'PERM');
  var c = findCourse_(rows[0].courseId);
  var markedBy = rows[0].markedBy;
  var desc = '«' + courseLabel_(c) + '» · Ay ' + rows[0].monthNo + ' · Tarix: ' + rows[0].date + ' · ' +
    entriesText_(rows.map(function (r) { return { studentId: r.studentId, status: r.status, reason: r.reason }; })) + ' · Qeyd edən: ' + userName_(markedBy);
  removeRows_('Lessons', rows.map(function (r) { return r._row; }));
  log_(u, 'lesson', 'Dərs qeydini sildi', desc);
  if (markedBy && markedBy !== u.id) notify_([markedBy], 'lesson', 'Admin «' + courseLabel_(c) + '» üzrə sizin dərs qeydinizi sildi (' + fmtD_(rows[0].date) + ').', 'mine', '');
  return {};
}
function fmtD_(s) { return String(s || '').slice(0, 10); }

function getLessons_(u, req) {
  var courseId = str_(req.courseId, 40);
  var own = false;
  if (courseId) { var cc = findCourse_(courseId); own = !!cc && cc.teacherId === u.id; }
  if (!own && !can_(u, 'attendance.view')) throw fail_('Dərs tarixçəsinə baxmaq üçün icazəniz yoxdur.', 'PERM');
  var P = permsOf_(u);
  var users = rows_('Users'), students = rows_('Students'), courses = rows_('Courses');
  var sMap = {}; students.forEach(function (x) { sMap[x.id] = x; });
  var uMap = {}; users.forEach(function (x) { uMap[x.id] = x; });
  var cMap = {}; courses.forEach(function (c) { cMap[c.id] = c; });
  var rows = rows_('Lessons');
  if (courseId) rows = rows.filter(function (l) { return l.courseId === courseId; });
  var list = events_(rows, u, P, sMap, uMap);
  list.forEach(function (e) {
    var c = cMap[e.courseId];
    e.courseExists = !!c;
    e.courseTitle = c ? courseLabelFrom_(c, sMap) : '(silinmiş məşğələ)';
    e.courseType = c ? c.type : '';
    e.teacherName = c && uMap[c.teacherId] ? uMap[c.teacherId].name : '—';
    e.lessonsPerMonth = c ? Number(c.lessonsPerMonth) : null;
    if (!c) e.canEdit = false;
  });
  var from = str_(req.from, 10), to = str_(req.to, 10), status = str_(req.status, 10), q = fold_(str_(req.q, 80));
  list = list.filter(function (e) {
    if (from && e.date < from) return false;
    if (to && e.date > to) return false;
    if (status === HELD && !e.held) return false;
    if (status === ABSENT && !e.entries.some(function (x) { return x.status === ABSENT; })) return false;
    if (q) {
      var hay = fold_([e.courseTitle, e.teacherName, e.markedByName, e.topic].concat(e.entries.map(function (x) { return x.studentName + ' ' + (x.reason || ''); })).join(' '));
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  });
  list.sort(function (a, b) { if (a.date !== b.date) return a.date < b.date ? 1 : -1; return a.markedAt < b.markedAt ? 1 : -1; });
  var offset = Math.max(0, Number(req.offset) || 0);
  var limit = Math.min(200, Math.max(1, Number(req.limit) || 50));
  return { lessons: list.slice(offset, offset + limit), total: list.length };
}

// ===================== ÖDƏNİŞLƏR =====================
function addPayment_(u, req) {
  need_(u, 'payments.add');
  var s = mustStudent_(req.studentId);
  var amount = Number(String(req.amount || '').replace(',', '.'));
  if (!isFinite(amount) || amount <= 0 || amount > 100000) throw fail_('Məbləği düzgün daxil edin.');
  amount = Math.round(amount * 100) / 100;
  var date = date_(req.date);
  var courseId = str_(req.courseId, 40);
  var c = null;
  var monthNo = '';
  if (courseId) {
    c = mustCourse_(courseId);
    var cur = Number(c.monthNo) || 1;
    // Köhnə ay (borc) üçün ödəniş: tələbə həmin ayda bu məşğələdə dərs keçibsə, artıq qrupda olmasa da qəbul olunur
    var m = req.monthNo === undefined || req.monthNo === '' ? cur : Number(req.monthNo);
    if (!(m >= 1 && m <= cur && Math.floor(m) === m)) throw fail_('Ay düzgün seçilməyib (1–' + cur + ').');
    var inCourse = idList_(c.studentIds).indexOf(s.id) !== -1;
    if (!inCourse) {
      var attended = rows_('Lessons').some(function (l) { return l.courseId === c.id && l.studentId === s.id && Number(l.monthNo) === m; });
      if (!attended) throw fail_('Bu tələbə seçilmiş məşğələdə iştirak etmir.');
    }
    monthNo = String(m);
  }
  var p = { id: newId_('P'), studentId: s.id, courseId: c ? c.id : '', monthNo: monthNo,
    amount: String(amount), date: date, note: str_(req.note, 200), createdBy: u.id, createdAt: now_() };
  insertMany_('Payments', [p]);
  log_(u, 'payment', 'Ödəniş əlavə etdi',
    s.name + ' · ' + amount + ' AZN · Tarix: ' + date + (c ? ' · Məşğələ: «' + courseLabel_(c) + '», Ay ' + p.monthNo : '') + (p.note ? ' · Qeyd: ' + p.note : ''));
  return { id: p.id };
}
function deletePayment_(u, req) {
  need_(u, 'payments.delete');
  var p = rows_('Payments').filter(function (x) { return x.id === String(req.id); })[0];
  if (!p) throw fail_('Ödəniş tapılmadı. Səhifəni yeniləyin.');
  removeRows_('Payments', [p._row]);
  log_(u, 'payment', 'Ödənişi sildi', studentName_(p.studentId) + ' · ' + p.amount + ' AZN · Tarix: ' + p.date + (p.note ? ' · Qeyd: ' + p.note : ''));
  return {};
}

// ===================== JURNAL =====================
function getLogs_(u, req) {
  need_(u, 'logs.view');
  var type = str_(req.type, 20), userId = str_(req.userId, 40), from = str_(req.from, 10), to = str_(req.to, 10), q = fold_(str_(req.q, 80));
  var since = monthsAgo_(ARCHIVE_MONTHS); // jurnal yalnız son 3 ayı göstərir
  var list = rows_('Logs').slice().reverse().filter(function (l) {
    if (l.type === 'dev') return false; // developer fəaliyyəti adi jurnalda görünmür
    if (type && l.type !== type) return false;
    if (userId && l.userId !== userId) return false;
    var d = String(l.time).slice(0, 10);
    if (d < since) return false;
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (q && fold_(l.userName + ' ' + l.action + ' ' + l.details).indexOf(q) === -1) return false;
    return true;
  });
  var offset = Math.max(0, Number(req.offset) || 0);
  var limit = Math.min(200, Math.max(1, Number(req.limit) || 20));
  return {
    logs: list.slice(offset, offset + limit).map(function (l) {
      return { id: l.id, time: l.time, userId: l.userId, userName: l.userName, role: l.role, type: l.type, action: l.action, details: l.details };
    }),
    total: list.length,
    retentionMonths: ARCHIVE_MONTHS,
    since: since
  };
}

// Developer fəaliyyəti — yalnız baş admin və developer görür (son 3 ay)
function getDevLog_(u, req) {
  if (u.role !== 'superadmin' && u.role !== 'developer') throw fail_('İcazə yoxdur.', 'PERM');
  var since = monthsAgo_(ARCHIVE_MONTHS);
  var list = rows_('Logs').slice().reverse().filter(function (l) { return l.type === 'dev' && String(l.time).slice(0, 10) >= since; });
  var offset = Math.max(0, Number(req.offset) || 0);
  var limit = Math.min(200, Math.max(1, Number(req.limit) || 20));
  // baxış bir dəfə qeyd olunur (səhifələmə və avtomatik yeniləmə jurnalı doldurmasın)
  if (u.role === 'superadmin' && req.first) log_(u, 'view', 'Developer fəaliyyətinə baxdı', '');
  return { logs: list.slice(offset, offset + limit).map(function (l) {
    return { id: l.id, time: l.time, userName: l.userName, action: l.action, details: l.details };
  }), total: list.length, retentionMonths: ARCHIVE_MONTHS, since: since };
}

// ===================== İCAZƏLƏR =====================
function setPermissions_(u, req) {
  if (u.role !== 'superadmin') throw fail_('«İcazələr» bölməsi yalnız baş admin üçündür.', 'PERM');
  var t = mustUser_(req.userId);
  if (t.role === 'superadmin' || t.role === 'developer') throw fail_('Bu hesabın icazələrini dəyişmək olmaz.');
  var wanted = (Array.isArray(req.permissions) ? req.permissions : []).map(String).filter(function (k) { return ALL_PERMS.indexOf(k) !== -1; });
  var next = expandPerms_(wanted);
  var prev = permsOf_(t);
  var added = next.filter(function (k) { return prev.indexOf(k) === -1; });
  var removed = prev.filter(function (k) { return next.indexOf(k) === -1; });
  update_('Users', t, { permissions: next.join(','), updatedAt: now_() });
  added.forEach(function (k) { log_(u, 'permission', 'İcazə verdi', '«' + t.name + '» istifadəçisinə «' + PERM_LABEL[k] + '» icazəsini verdi'); });
  removed.forEach(function (k) { log_(u, 'permission', 'İcazəni geri aldı', '«' + t.name + '» istifadəçisindən «' + PERM_LABEL[k] + '» icazəsini geri aldı'); });
  if (!added.length && !removed.length) log_(u, 'permission', 'İcazələri yadda saxladı', '«' + t.name + '» — dəyişiklik edilmədi');
  if (added.length || removed.length) notify_([t.id], 'perm', 'İcazələriniz baş admin tərəfindən yeniləndi.', '', '');
  return { added: added.length, removed: removed.length };
}

// ===================== BİLDİRİŞLƏR (route) =====================
function markNotif_(u, req) {
  var n = rawRows_('Notifs').filter(function (x) { return x.id === String(req.id) && x.userId === u.id; })[0];
  if (n && !n.readAt) update_('Notifs', n, { readAt: now_() });
  return {};
}
function markAllNotifs_(u, req) {
  rawRows_('Notifs').forEach(function (n) { if (n.userId === u.id && !n.readAt) update_('Notifs', n, { readAt: now_() }); });
  return {};
}

// ===================== ELANLAR =====================
function listAnns_(u, req) {
  need_(u, 'announce.send');
  return { anns: rawRows_('Anns').sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; }).map(function (a) {
    return { id: a.id, title: a.title, body: a.body, popup: a.popup === 'true', active: a.active === 'true', by: userName_(a.createdBy), createdAt: a.createdAt };
  }) };
}
function saveAnn_(u, req) {
  need_(u, 'announce.send');
  var title = reqStr_(req.title, 'Başlıq', 2, 120);
  var body = reqStr_(req.body, 'Mətn', 2, 2000);
  var popup = req.popup ? 'true' : 'false';
  var active = (req.active === false) ? 'false' : 'true';
  if (req.id) {
    var a = rawRows_('Anns').filter(function (x) { return x.id === String(req.id); })[0];
    if (!a) throw fail_('Elan tapılmadı.');
    var wasActive = a.active === 'true', wasPopup = a.popup === 'true';
    update_('Anns', a, { title: title, body: body, popup: popup, active: active, updatedAt: now_() });
    // Yenidən aktivləşdirmə/yeni popup → köhnə "görülüb" qeydlərini sıfırla
    if ((active === 'true' && !wasActive) || (popup === 'true' && !wasPopup)) resetAnnSeen_(a.id, popup === 'true');
    markAuthorSeen_(a.id, u.id); // müəllif öz elanını görmür
    log_(u, 'announce', 'Elanı redaktə etdi', '«' + title + '»');
    return { id: a.id };
  }
  var id = newId_('AN');
  insertMany_('Anns', [{ id: id, title: title, body: body, popup: popup, active: active, createdBy: u.id, createdAt: now_(), updatedAt: '' }]);
  markAuthorSeen_(id, u.id);
  log_(u, 'announce', 'Elan göndərdi', '«' + title + '»' + (popup === 'true' ? ' · Girişdə pəncərə' : ''));
  return { id: id };
}
function markAuthorSeen_(annId, userId) {
  update_('AnnSeen', annSeenRow_(annId, userId), { dismissedAt: now_(), popupSeenAt: now_() });
}
function resetAnnSeen_(annId, popupToo) {
  rawRows_('AnnSeen').filter(function (x) { return x.annId === annId; }).forEach(function (x) {
    var ch = { dismissedAt: '' };
    if (popupToo) ch.popupSeenAt = '';
    update_('AnnSeen', x, ch);
  });
}
function deleteAnn_(u, req) {
  need_(u, 'announce.send');
  var a = rawRows_('Anns').filter(function (x) { return x.id === String(req.id); })[0];
  if (!a) throw fail_('Elan tapılmadı.');
  removeRows_('Anns', [a._row]);
  var seen = rawRows_('AnnSeen').filter(function (x) { return x.annId === a.id; });
  if (seen.length) removeRows_('AnnSeen', seen.map(function (x) { return x._row; }));
  log_(u, 'announce', 'Elanı sildi', '«' + a.title + '»');
  return {};
}
function annSeenRow_(annId, userId) {
  var r = rawRows_('AnnSeen').filter(function (x) { return x.annId === annId && x.userId === userId; })[0];
  if (!r) { insertMany_('AnnSeen', [{ id: newId_('AS'), annId: annId, userId: userId, dismissedAt: '', popupSeenAt: '' }]);
    r = rawRows_('AnnSeen').filter(function (x) { return x.annId === annId && x.userId === userId; })[0]; }
  return r;
}
function dismissAnn_(u, req) {
  var a = rawRows_('Anns').filter(function (x) { return x.id === String(req.id); })[0];
  if (!a) return {};
  update_('AnnSeen', annSeenRow_(a.id, u.id), { dismissedAt: now_() });
  return {};
}
function seenPopup_(u, req) {
  var a = rawRows_('Anns').filter(function (x) { return x.id === String(req.id); })[0];
  if (!a) return {};
  update_('AnnSeen', annSeenRow_(a.id, u.id), { popupSeenAt: now_() });
  return {};
}

// ===================== SORĞULAR =====================
function surveyQuestions_() { return settingGet_('survey') || DEFAULT_SURVEY; }

function getSurveyQuestions_(u, req) {
  if (!can_(u, 'survey.edit') && !can_(u, 'survey.view') && !can_(u, 'survey.send')) throw fail_('İcazə yoxdur.', 'PERM');
  return { survey: surveyQuestions_(), canEdit: can_(u, 'survey.edit') };
}
function saveSurveyQuestions_(u, req) {
  need_(u, 'survey.edit');
  var cur = surveyQuestions_();
  var intro = str_(req.intro, 600) || cur.intro;
  var inQ = Array.isArray(req.questions) ? req.questions : [];
  var qs = [];
  inQ.forEach(function (q, i) {
    var text = str_(q.text, 300);
    if (!text) return;
    var type = ['scale5', 'choice', 'nps', 'text'].indexOf(q.type) !== -1 ? q.type : 'scale5';
    var o = { id: 'q' + (i + 1), type: type, text: text };
    if (type === 'choice') {
      var opts = (Array.isArray(q.options) ? q.options : []).map(function (x) { return str_(x, 60); }).filter(String);
      if (opts.length < 2) throw fail_('«' + text + '» sualı üçün ən azı 2 variant yazın.');
      o.options = opts;
      if (Array.isArray(q.bad)) o.bad = q.bad.map(function (x) { return str_(x, 60); }).filter(function (x) { return opts.indexOf(x) !== -1; });
    }
    if (q.teacher) o.teacher = true;
    if (q.optional || type === 'text') o.optional = true;
    qs.push(o);
  });
  if (!qs.length) throw fail_('Ən azı bir sual olmalıdır.');
  var next = { version: (Number(cur.version) || 1) + 1, intro: intro, questions: qs };
  settingSet_('survey', next);
  log_(u, 'survey', 'Sorğu suallarını dəyişdi', qs.length + ' sual · versiya ' + next.version);
  return { survey: next };
}

// Hədəf siyahısı: tələbələr və onların cari ay statusu
function surveyTargets_(u, req) {
  need_(u, 'survey.send');
  var mk = monthKey_();
  var surveys = rawRows_('Surveys');
  var byStudent = {};
  surveys.forEach(function (sv) {
    var key = sv.studentId;
    if (!byStudent[key]) byStudent[key] = [];
    byStudent[key].push(sv);
  });
  var courses = rows_('Courses');
  var out = rows_('Students').map(function (s) {
    var cs = courses.filter(function (c) { return idList_(c.studentIds).indexOf(s.id) !== -1; });
    var mine = (byStudent[s.id] || []).filter(function (sv) { return String(sv.sentAt).slice(0, 7) === mk; });
    var answered = mine.some(function (sv) { return sv.status === 'answered'; });
    var sent = mine.length > 0;
    return {
      id: s.id, name: s.name, parentPhone: s.parentPhone,
      courses: cs.map(function (c) { return { id: c.id, title: courseLabel_(c), teacherId: c.teacherId, teacherName: userName_(c.teacherId) }; }),
      status: answered ? 'answered' : (sent ? 'sent' : 'none')
    };
  }).sort(function (a, b) { return a.name.localeCompare(b.name, 'az'); });
  return { targets: out, monthKey: mk };
}

function sendSurvey_(u, req) {
  need_(u, 'survey.send');
  var s = mustStudent_(req.studentId);
  var cs = rows_('Courses').filter(function (c) { return idList_(c.studentIds).indexOf(s.id) !== -1; });
  if (!cs.length) throw fail_('Bu tələbə heç bir məşğələdə yoxdur.');
  var course = req.courseId ? cs.filter(function (c) { return c.id === String(req.courseId); })[0] : cs[0];
  if (!course) throw fail_('Məşğələ tapılmadı.');
  var mk = monthKey_();
  // Bu ay artıq cavablanmış sorğu varsa, yenisini yaratma
  var existing = rawRows_('Surveys').filter(function (sv) {
    return sv.studentId === s.id && String(sv.sentAt).slice(0, 7) === mk;
  });
  var answered = existing.filter(function (sv) { return sv.status === 'answered'; })[0];
  if (answered) throw fail_('Bu tələbə bu ay sorğunu artıq cavablandırıb.');
  var open = existing.filter(function (sv) { return sv.status === 'sent' && sv.courseId === course.id; })[0];
  var survey = surveyQuestions_();
  if (open) {
    log_(u, 'survey', 'Sorğu linkini yenidən götürdü', s.name);
    return link_(open, s, course);
  }
  var row = {
    id: newId_('SV'), token: newToken_(), studentId: s.id, courseId: course.id, teacherId: course.teacherId,
    monthNo: String(course.monthNo || 1), status: 'sent', qVersion: String(survey.version),
    questions: JSON.stringify(survey.questions), answers: '', sentBy: u.id, sentAt: now_(), answeredAt: '',
    adminStatus: '', adminNote: '', lowFlag: ''
  };
  insertMany_('Surveys', [row]);
  log_(u, 'survey', 'Sorğu linki göndərdi', s.name + ' · Müəllim: ' + userName_(course.teacherId) + ' · «' + courseLabel_(course) + '»');
  return link_(row, s, course);
}
function link_(sv, s, course) {
  return { token: sv.token, studentName: s.name, teacherName: userName_(course.teacherId), parentPhone: s.parentPhone, courseTitle: courseLabel_(course) };
}

function surveyResponses_(u, req) {
  need_(u, 'survey.view');
  var users = rows_('Users'), courses = rawRows_('Courses');
  var uMap = {}; users.forEach(function (x) { uMap[x.id] = x; });
  var cMap = {}; courses.forEach(function (c) { cMap[c.id] = c; });
  var all = rawRows_('Surveys').filter(function (sv) { return sv.status === 'answered'; });
  var teacherId = str_(req.teacherId, 40), monthK = str_(req.month, 7), low = !!req.low, onlyNew = !!req.onlyNew;
  var list = all.map(function (sv) {
    var ans = []; try { ans = JSON.parse(sv.answers || '[]'); } catch (e) {}
    var qs = []; try { qs = JSON.parse(sv.questions || '[]'); } catch (e) {}
    return {
      id: sv.id, studentName: studentName_(sv.studentId), teacherId: sv.teacherId, teacherName: uMap[sv.teacherId] ? uMap[sv.teacherId].name : '(silinmiş)',
      courseTitle: cMap[sv.courseId] ? courseLabel_(cMap[sv.courseId]) : '(silinmiş məşğələ)',
      monthKey: String(sv.answeredAt).slice(0, 7), answeredAt: sv.answeredAt,
      answers: qs.map(function (q) { var a = ans.filter(function (x) { return x.id === q.id; })[0]; return { q: q.text, type: q.type, value: a ? a.value : '' }; }),
      low: sv.lowFlag === 'true', adminStatus: sv.adminStatus || 'new', adminNote: sv.adminNote || '',
      teacherScore: teacherScore_(qs, ans)
    };
  });
  var filtered = list.filter(function (r) {
    if (teacherId && r.teacherId !== teacherId) return false;
    if (monthK && r.monthKey !== monthK) return false;
    if (low && !r.low) return false;
    if (onlyNew && r.adminStatus !== 'new') return false;
    return true;
  }).sort(function (a, b) { return a.answeredAt < b.answeredAt ? 1 : -1; });

  // Sводka: müəllim üzrə orta bal
  var byTeacher = {};
  list.forEach(function (r) {
    if (r.teacherScore == null) return;
    var k = r.teacherId;
    if (!byTeacher[k]) byTeacher[k] = { teacherId: k, teacherName: r.teacherName, sum: 0, n: 0, low: 0, total: 0 };
    byTeacher[k].sum += r.teacherScore; byTeacher[k].n++;
  });
  list.forEach(function (r) { var k = r.teacherId; if (byTeacher[k]) { byTeacher[k].total++; if (r.low) byTeacher[k].low++; } });
  var summary = Object.keys(byTeacher).map(function (k) {
    var t = byTeacher[k];
    return { teacherId: k, teacherName: t.teacherName, avg: t.n ? Math.round(t.sum / t.n * 10) / 10 : null, responses: t.total, low: t.low };
  }).sort(function (a, b) { return (b.avg || 0) - (a.avg || 0); });

  var months = {}; list.forEach(function (r) { months[r.monthKey] = (months[r.monthKey] || 0) + 1; });
  var monthList = Object.keys(months).sort().reverse();
  var teachers = {}; list.forEach(function (r) { teachers[r.teacherId] = r.teacherName; });

  return {
    responses: filtered, summary: summary, total: all.length, shown: filtered.length,
    months: monthList, teachers: Object.keys(teachers).map(function (k) { return { id: k, name: teachers[k] }; })
  };
}
function teacherScore_(qs, ans) {
  var sum = 0, n = 0;
  qs.forEach(function (q) {
    if (q.type === 'scale5' && q.teacher) {
      var a = ans.filter(function (x) { return x.id === q.id; })[0];
      if (a && Number(a.value) >= 1) { sum += Number(a.value); n++; }
    }
  });
  return n ? Math.round(sum / n * 10) / 10 : null;
}
function setSurveyStatus_(u, req) {
  need_(u, 'survey.view');
  var sv = rawRows_('Surveys').filter(function (x) { return x.id === String(req.id); })[0];
  if (!sv) throw fail_('Cavab tapılmadı.');
  var st = ['new', 'reviewed', 'contacted'].indexOf(req.status) !== -1 ? req.status : sv.adminStatus;
  var note = str_(req.note, 500);
  update_('Surveys', sv, { adminStatus: st, adminNote: note });
  var lbl = { new: 'Yeni', reviewed: 'Baxıldı', contacted: 'Valideynlə əlaqə saxlanıldı' };
  log_(u, 'survey', 'Sorğu cavabının statusunu dəyişdi', studentName_(sv.studentId) + ' → ' + (lbl[st] || st) + (note ? ' · ' + note : ''));
  return {};
}

// ---- Public survey ----
function publicSurveyInfo_(req) {
  var sv = rawRows_('Surveys').filter(function (x) { return x.token === String(req.token || ''); })[0];
  if (!sv) throw fail_('Sorğu tapılmadı. Link yanlışdır.', 'NOTFOUND');
  if (sv.status === 'answered') return { state: 'answered' };
  if (ageHours_(sv.sentAt) > SURVEY_TTL_DAYS * 24) return { state: 'expired' };
  var qs = []; try { qs = JSON.parse(sv.questions || '[]'); } catch (e) {}
  var survey = surveyQuestions_();
  var course = findCourse_(sv.courseId);
  return {
    state: 'open',
    studentName: studentName_(sv.studentId),
    teacherName: userName_(sv.teacherId),
    courseTitle: course ? courseLabel_(course) : '',
    intro: survey.intro || DEFAULT_SURVEY.intro,
    questions: qs
  };
}
function submitSurvey_(req) {
  var sv = rawRows_('Surveys').filter(function (x) { return x.token === String(req.token || ''); })[0];
  if (!sv) throw fail_('Sorğu tapılmadı. Link yanlışdır.', 'NOTFOUND');
  if (sv.status === 'answered') return { state: 'answered' };
  if (ageHours_(sv.sentAt) > SURVEY_TTL_DAYS * 24) return { state: 'expired' };
  var qs = []; try { qs = JSON.parse(sv.questions || '[]'); } catch (e) {}
  var inAns = {};
  (Array.isArray(req.answers) ? req.answers : []).forEach(function (a) { if (a && a.id) inAns[a.id] = a.value; });
  var out = [], low = false;
  qs.forEach(function (q) {
    var v = inAns[q.id];
    if (q.type === 'scale5') {
      var n = Number(v);
      if (!(n >= 1 && n <= 5)) throw fail_('Bütün suallara cavab verin.');
      if (n <= 2) low = true;
      out.push({ id: q.id, value: n });
    } else if (q.type === 'nps') {
      var m = Number(v);
      if (!(m >= 0 && m <= 10)) throw fail_('Bütün suallara cavab verin.');
      if (m <= 6) low = true;
      out.push({ id: q.id, value: m });
    } else if (q.type === 'choice') {
      if ((q.options || []).indexOf(v) === -1) throw fail_('Bütün suallara cavab verin.');
      if ((q.bad || []).indexOf(v) !== -1) low = true;
      out.push({ id: q.id, value: v });
    } else { // text
      out.push({ id: q.id, value: str_(v, 1000) });
    }
  });
  update_('Surveys', sv, { status: 'answered', answers: JSON.stringify(out), answeredAt: now_(), lowFlag: low ? 'true' : 'false', adminStatus: 'new' });
  notify_(adminsFor_('survey.view', ''), 'survey', 'Yeni sorğu cavabı: ' + studentName_(sv.studentId) + (low ? ' (aşağı qiymət!)' : ''), 'tools', 'surveys');
  return { state: 'done' };
}

// ---- Public card ----
function publicCard_(req) {
  var s = rows_('Students').filter(function (x) { return x.cardToken && x.cardToken === String(req.token || ''); })[0];
  if (!s) throw fail_('Tələbə tapılmadı. Link yanlışdır.', 'NOTFOUND');
  return { card: buildCard_(s, null, true) };
}

// ===================== ALƏTLƏR =====================
function trashList_(u, req) {
  need_(u, 'tools.trash');
  var purgeHint = TRASH_DAYS;
  var out = { students: [], users: [], courses: [], purgeDays: purgeHint };
  trashRows_('Students').forEach(function (s) {
    out.students.push({ id: s.id, name: s.name, phone: s.phone, deletedAt: s.deletedAt, deletedBy: userName_(s.deletedBy), daysLeft: daysLeft_(s.deletedAt) });
  });
  trashRows_('Users').forEach(function (x) {
    out.users.push({ id: x.id, name: x.name, login: x.login, role: x.role, deletedAt: x.deletedAt, deletedBy: userName_(x.deletedBy), daysLeft: daysLeft_(x.deletedAt) });
  });
  trashRows_('Courses').forEach(function (c) {
    out.courses.push({ id: c.id, title: courseLabel_(c), type: c.type, teacherName: userName_(c.teacherId), deletedAt: c.deletedAt, deletedBy: userName_(c.deletedBy), daysLeft: daysLeft_(c.deletedAt) });
  });
  return out;
}
function daysLeft_(deletedAt) { return Math.max(0, Math.ceil(TRASH_DAYS - ageHours_(deletedAt) / 24)); }

function restoreItem_(u, req) {
  need_(u, 'tools.trash');
  var kind = req.kind, sheet = { student: 'Students', user: 'Users', course: 'Courses' }[kind];
  if (!sheet) throw fail_('Naməlum element.');
  var r = trashRows_(sheet).filter(function (x) { return x.id === String(req.id); })[0];
  if (!r) throw fail_('Element tapılmadı.');
  if (sheet === 'Users') {
    var dup = rows_('Users').filter(function (x) { return lower_(x.login) === lower_(r.login); })[0];
    if (dup) throw fail_('«' + r.login + '» logini artıq istifadə olunur. Bərpadan əvvəl digərini dəyişin.');
  }
  update_(sheet, r, { deletedAt: '', deletedBy: '' });
  var nm = sheet === 'Courses' ? courseLabel_(r) : r.name;
  log_(u, 'trash', 'Zibildən bərpa etdi', (kind === 'student' ? 'Tələbə' : kind === 'user' ? 'İstifadəçi' : 'Məşğələ') + ': ' + nm);
  return {};
}
function purgeItem_(u, req) {
  need_(u, 'tools.trash');
  var kind = req.kind, sheet = { student: 'Students', user: 'Users', course: 'Courses' }[kind];
  if (!sheet) throw fail_('Naməlum element.');
  var r = trashRows_(sheet).filter(function (x) { return x.id === String(req.id); })[0];
  if (!r) throw fail_('Element tapılmadı.');
  var nm = sheet === 'Courses' ? courseLabel_(r) : r.name;
  if (sheet === 'Courses') {
    var lr = rows_('Lessons').filter(function (l) { return l.courseId === r.id; });
    if (lr.length) removeRows_('Lessons', lr.map(function (l) { return l._row; }));
  }
  removeRows_(sheet, [r._row]);
  log_(u, 'trash', 'Həmişəlik sildi', (kind === 'student' ? 'Tələbə' : kind === 'user' ? 'İstifadəçi' : 'Məşğələ') + ': ' + nm);
  return {};
}

function teacherLeave_(u, req) {
  need_(u, 'tools.bulk');
  var t = mustUser_(req.teacherId);
  var to = mustUser_(req.toTeacherId);
  if (t.id === to.id) throw fail_('Eyni müəllim seçildi.');
  if (to.role !== 'teacher' && to.role !== 'superadmin') throw fail_('Hədəf müəllim düzgün deyil.');
  var cs = rows_('Courses').filter(function (c) { return c.teacherId === t.id; });
  if (!cs.length) throw fail_('Bu müəllimin məşğələsi yoxdur.');
  cs.forEach(function (c) { update_('Courses', c, { teacherId: to.id, updatedAt: now_() }); });
  log_(u, 'course', 'Müəllimin məşğələlərini köçürdü', cs.length + ' məşğələ: ' + t.name + ' → ' + to.name);
  if (to.id !== u.id) notify_([to.id], 'course', cs.length + ' məşğələ sizə köçürüldü (əvvəlki müəllim: ' + t.name + ').', 'mine', '');
  return { moved: cs.length };
}

function moveStudents_(u, req) {
  need_(u, 'tools.bulk');
  var from = mustCourse_(req.fromCourseId);
  var to = mustCourse_(req.toCourseId);
  if (from.id === to.id) throw fail_('Mənbə və hədəf eyni ola bilməz.');
  if (to.type === 'individual') throw fail_('Fərdi məşğələyə köçürmək olmaz.');
  var ids = (Array.isArray(req.studentIds) ? req.studentIds : []).map(String);
  var fromIds = idList_(from.studentIds);
  ids = ids.filter(function (id) { return fromIds.indexOf(id) !== -1; });
  if (!ids.length) throw fail_('Köçürüləcək tələbə seçilməyib.');
  if (from.type === 'group' && fromIds.length - ids.length < 2 && fromIds.length - ids.length > 0) throw fail_('Köçürmədən sonra mənbə qrupda 2-dən az tələbə qalır.');
  var toIds = idList_(to.studentIds);
  ids.forEach(function (id) { if (toIds.indexOf(id) === -1) toIds.push(id); });
  update_('Courses', from, { studentIds: fromIds.filter(function (x) { return ids.indexOf(x) === -1; }).join(','), updatedAt: now_() });
  update_('Courses', to, { studentIds: toIds.join(','), updatedAt: now_() });
  ids.forEach(function (id) { insertMany_('Transfers', [{ id: newId_('T'), studentId: id, fromCourseId: from.id, toCourseId: to.id, byUser: u.id, at: now_(), note: 'Toplu köçürmə' }]); });
  log_(u, 'transfer', 'Tələbələri köçürdü', ids.length + ' tələbə: «' + courseLabel_(from) + '» → «' + courseLabel_(to) + '»');
  return { moved: ids.length };
}

function dataCheck_(u, req) {
  need_(u, 'tools.datacheck');
  var issues = [];
  var students = rows_('Students'), courses = rows_('Courses'), lessons = rows_('Lessons'), payments = rows_('Payments');
  var sIds = {}; students.forEach(function (s) { sIds[s.id] = true; });
  var cIds = {}; courses.forEach(function (c) { cIds[c.id] = true; });

  // Dubl tələbələr (ad üzrə)
  var byName = {};
  students.forEach(function (s) { var k = fold_(s.name); (byName[k] = byName[k] || []).push(s.name); });
  Object.keys(byName).forEach(function (k) { if (byName[k].length > 1) issues.push({ type: 'warn', text: 'Eyni adlı tələbələr: ' + byName[k].join(', ') }); });
  // Dubl telefon
  var byPhone = {};
  students.forEach(function (s) { var d = digits_(s.phone); if (d.length >= 7) (byPhone[d] = byPhone[d] || []).push(s.name); });
  Object.keys(byPhone).forEach(function (k) { if (byPhone[k].length > 1) issues.push({ type: 'warn', text: 'Eyni telefon: ' + byPhone[k].join(', ') }); });

  // Boş və ya tək tələbəli qruplar
  courses.forEach(function (c) {
    var ids = idList_(c.studentIds).filter(function (id) { return sIds[id]; });
    if (ids.length === 0) issues.push({ type: 'err', text: '«' + courseLabel_(c) + '» məşğələsində tələbə yoxdur.' });
    else if (c.type === 'group' && ids.length < 2) issues.push({ type: 'warn', text: '«' + courseLabel_(c) + '» qrupunda cəmi 1 tələbə var.' });
    var missing = idList_(c.studentIds).filter(function (id) { return !sIds[id]; });
    if (missing.length) issues.push({ type: 'err', text: '«' + courseLabel_(c) + '» məşğələsində silinmiş tələbəyə istinad var (' + missing.length + ').' });
    // Normadan artıq keçid
    var m = Number(c.monthNo) || 1, N = Number(c.lessonsPerMonth) || 8;
    if (heldIn_(c.id, m, null) > N) issues.push({ type: 'err', text: '«' + courseLabel_(c) + '»: cari ayda keçirilən dərs sayı normadan (' + N + ') çoxdur.' });
  });

  // Silinmiş məşğələyə bağlı dərslər / ödənişlər (aktiv olmayan kurs)
  var lessonOrphan = 0, lessonSet = {};
  lessons.forEach(function (l) { if (!cIds[l.courseId]) lessonSet[l.courseId] = true; });
  lessonOrphan = Object.keys(lessonSet).length;
  if (lessonOrphan) issues.push({ type: 'info', text: lessonOrphan + ' məşğələyə aid dərs qeydləri var, lakin məşğələ artıq aktiv deyil (silinib).' });
  var payOrphanS = payments.filter(function (p) { return !sIds[p.studentId]; }).length;
  if (payOrphanS) issues.push({ type: 'warn', text: payOrphanS + ' ödəniş silinmiş tələbəyə aiddir.' });
  var tc = testCounts_(testScope_());
  if (tc.teachers || tc.students || tc.courses) issues.push({ type: 'info', text: 'Sistemdə test məlumatları var: ' + tc.teachers + ' müəllim, ' + tc.students + ' tələbə, ' + tc.courses + ' məşğələ. Developer onları bir düymə ilə silə bilər.' });

  log_(u, 'tools', 'Məlumatları yoxladı', 'Tapılan problem sayı: ' + issues.length);
  return { issues: issues, counts: { students: students.length, courses: courses.length, lessons: lessons.length, payments: payments.length } };
}

// ===================== YENİLİKLƏR (Changelog) =====================
function listChangelog_(u, req) {
  return { items: rawRows_('Changelog').sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; }).map(function (c) {
    return { id: c.id, title: c.title, body: c.body, kind: c.kind || 'update', createdAt: c.createdAt, by: userName_(c.createdBy) };
  }), canEdit: u.role === 'developer' };
}
function addChangelog_(u, req) {
  if (u.role !== 'developer') throw fail_('Yalnız developer yenilik əlavə edə bilər.', 'PERM');
  var title = reqStr_(req.title, 'Başlıq', 2, 160);
  var body = str_(req.body, 3000);
  var kind = ['update', 'fix', 'new'].indexOf(req.kind) !== -1 ? req.kind : 'update';
  if (req.id) {
    var c = rawRows_('Changelog').filter(function (x) { return x.id === String(req.id); })[0];
    if (!c) throw fail_('Qeyd tapılmadı.');
    var was = c.title;
    update_('Changelog', c, { title: title, body: body, kind: kind });
    log_(u, 'dev', 'Yeniliyi redaktə etdi', was === title ? title : '«' + was + '» → «' + title + '»');
    return { id: c.id };
  }
  var id = newId_('CL');
  insertMany_('Changelog', [{ id: id, title: title, body: body, kind: kind, createdBy: u.id, createdAt: now_() }]);
  log_(u, 'dev', 'Yenilik əlavə etdi', title);
  return { id: id };
}
function deleteChangelog_(u, req) {
  if (u.role !== 'developer') throw fail_('İcazə yoxdur.', 'PERM');
  var c = rawRows_('Changelog').filter(function (x) { return x.id === String(req.id); })[0];
  if (!c) throw fail_('Qeyd tapılmadı.');
  removeRows_('Changelog', [c._row]);
  log_(u, 'dev', 'Yeniliyi sildi', c.title);
  return {};
}
// İstifadəçi «Yeniliklər»i açdı — sayğac sıfırlanır. Jurnala yalnız oxunmamış qeyd olanda yazılır.
function markNewsSeen_(u, req) {
  if (u.role === 'developer') return { unread: 0 };
  var seen = newsSeenAt_(u);
  var fresh = rawRows_('Changelog').filter(function (c) { return c.createdAt > seen; });
  if (!fresh.length) return { unread: 0 };
  update_('Users', u, { newsSeenAt: now_() });
  log_(u, 'view', 'Yenilikləri oxudu', fresh.length + ' yeni qeyd: ' + fresh.map(function (c) { return c.title; }).slice(0, 5).join('; '));
  return { unread: 0 };
}

// ===================== DEVELOPER =====================
function setMaintenance_(u, req) {
  if (u.role !== 'developer') throw fail_('Yalnız developer texniki rejimi idarə edə bilər.', 'PERM');
  var on = !!req.on;
  var text = on ? str_(req.text, 300) : '';            // developerin əlavə qeydi (istəyə bağlı)
  var minutes = on ? Number(req.minutes) || 0 : 0;      // təxmini müddət (0 = naməlum)
  if ([0, 15, 30, 60, 120, 240].indexOf(minutes) === -1) minutes = 0;
  var until = minutes ? Utilities.formatDate(new Date(Date.now() + minutes * 60000), TIMEZONE, 'yyyy-MM-dd HH:mm:ss') : '';
  settingSet_('maintenance', { on: on, text: text, until: until, by: u.name, at: now_() });
  log_(u, 'dev', on ? 'Texniki rejimi açdı' : 'Texniki rejimi bağladı',
    on ? ((minutes ? 'Təxmini müddət: ' + minutes + ' dəq' : 'Müddət göstərilməyib') + (text ? ' · Qeyd: ' + text : '')) : '');
  return { maintenance: maint_() };
}
function devStats_(u, req) {
  if (u.role !== 'developer' && u.role !== 'superadmin') throw fail_('İcazə yoxdur.', 'PERM');
  var sheets = {};
  Object.keys(SCHEMA).forEach(function (name) { sheets[name] = rawRows_(name).length; });
  var surveys = rawRows_('Surveys');
  return {
    sheets: sheets,
    students: rows_('Students').length, trashStudents: trashRows_('Students').length,
    courses: rows_('Courses').length, users: rows_('Users').length,
    lessons: rawRows_('Lessons').length, surveysSent: surveys.length, surveysAnswered: surveys.filter(function (s) { return s.status === 'answered'; }).length,
    surveyVersion: surveyQuestions_().version, now: now_()
  };
}

// ===================== TEST MƏLUMATLARI (yalnız developer) =====================
// Bütün yaradılan qeydlərin adı «Test» sözü ilə başlayır və isTest=true işarəsi daşıyır —
// bir düymə ilə tam silinir. Telefon nömrələri yazılmır (təsadüfən real nömrəyə mesaj getməsin).
var TEST_NAMES_F = ['Aysel', 'Nigar', 'Leyla', 'Günay', 'Səbinə', 'Nərmin', 'Aynur', 'Fidan', 'Zəhra', 'Lalə', 'Aytac', 'Könül'];
var TEST_NAMES_M = ['Kamran', 'Tural', 'Orxan', 'Elvin', 'Rauf', 'Murad', 'Fərid', 'Nicat', 'Ülvi', 'Rəşad', 'Samir', 'Emil'];
var TEST_SURNAMES = ['Əliyev', 'Məmmədov', 'Həsənov', 'Hüseynov', 'Quliyev', 'Cəfərov', 'Kərimov', 'İsmayılov', 'Rəhimov', 'Abbasov', 'Nəsirov', 'Babayev'];
var TEST_SUBJECTS = ['İngilis dili', 'Rus dili', 'Riyaziyyat', 'Alman dili', 'Fizika', 'Kimya'];
var TEST_TOPICS = ['Present Simple', 'Past Simple', 'Lüğət: ailə', 'Oxu tapşırığı', 'Danışıq praktikası', 'Test işi', 'Dinləmə', 'Qrammatika təkrarı', ''];
var TEST_REASONS = ['Xəstə idi', 'Ailə səbəbi', 'Səfərdə idi', 'Xəbər vermədi'];
var TEST_PASSWORD = 'test1234';

function needDev_(u) { if (u.role !== 'developer') throw fail_('Bu əməliyyat yalnız developer üçündür.', 'PERM'); }
function pick_(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function daysAgo_(n) { return Utilities.formatDate(new Date(Date.now() - n * 864e5), TIMEZONE, 'yyyy-MM-dd'); }
function testPerson_() {
  var female = Math.random() < 0.5;
  var sur = pick_(TEST_SURNAMES);
  return 'Test ' + (female ? pick_(TEST_NAMES_F) : pick_(TEST_NAMES_M)) + ' ' + (female ? sur + 'a' : sur);
}

// Test qeydləri və onlardan asılı sətirlər (silinmə üçün də istifadə olunur)
function testScope_() {
  var tU = {}, tS = {}, tC = {};
  rawRows_('Users').forEach(function (x) { if (isTrue_(x.isTest)) tU[x.id] = x; });
  rawRows_('Students').forEach(function (x) { if (isTrue_(x.isTest)) tS[x.id] = x; });
  rawRows_('Courses').forEach(function (x) { if (isTrue_(x.isTest)) tC[x.id] = x; });
  var lessons = rawRows_('Lessons').filter(function (l) { return tC[l.courseId] || tS[l.studentId]; });
  var payments = rawRows_('Payments').filter(function (p) { return tS[p.studentId] || tC[p.courseId]; });
  var transfers = rawRows_('Transfers').filter(function (t) { return tS[t.studentId] || tC[t.fromCourseId] || tC[t.toCourseId]; });
  var surveys = rawRows_('Surveys').filter(function (s) { return tS[s.studentId] || tC[s.courseId] || tU[s.teacherId]; });
  var notifs = rawRows_('Notifs').filter(function (n) { return tU[n.userId]; });
  var annSeen = rawRows_('AnnSeen').filter(function (n) { return tU[n.userId]; });
  // Real (test olmayan) məşğələ test müəllimə bağlıdırsa — silmək olmaz, əvvəlcə müəllimi dəyişmək lazımdır
  var conflicts = rows_('Courses').filter(function (c) { return !tC[c.id] && tU[c.teacherId]; });
  var realWithTestStudents = rawRows_('Courses').filter(function (c) {
    return !tC[c.id] && idList_(c.studentIds).some(function (id) { return tS[id]; });
  });
  return { tU: tU, tS: tS, tC: tC, lessons: lessons, payments: payments, transfers: transfers, surveys: surveys,
    notifs: notifs, annSeen: annSeen, conflicts: conflicts, realWithTestStudents: realWithTestStudents };
}
function testCounts_(sc) {
  var lessonIds = {}; sc.lessons.forEach(function (l) { lessonIds[l.lessonId] = true; });
  return {
    teachers: Object.keys(sc.tU).length, students: Object.keys(sc.tS).length, courses: Object.keys(sc.tC).length,
    lessons: Object.keys(lessonIds).length, payments: sc.payments.length,
    other: sc.transfers.length + sc.surveys.length + sc.notifs.length + sc.annSeen.length
  };
}
function testDataInfo_(u, req) {
  needDev_(u);
  var sc = testScope_();
  return {
    counts: testCounts_(sc), password: TEST_PASSWORD, limits: TEST_LIMITS,
    conflicts: sc.conflicts.map(function (c) { return courseLabel_(c) + ' (müəllim: ' + userName_(c.teacherId) + ')'; }),
    mixed: sc.realWithTestStudents.length
  };
}

function genTestData_(u, req) {
  needDev_(u);
  var n = function (k, min) {
    var v = Math.floor(Number(req[k]) || 0);
    if (v < (min || 0) || v > TEST_LIMITS[k]) throw fail_('Say düzgün deyil: ' + k + ' (0–' + TEST_LIMITS[k] + ').');
    return v;
  };
  var nT = n('teachers'), nS = n('students'), nC = n('courses'), nL = n('lessons');
  var mix = ['mixed', 'individual', 'group'].indexOf(req.mix) !== -1 ? req.mix : 'mixed';
  var withPay = !!req.payments, withPast = !!req.pastMonth;
  if (!nT && !nS && !nC) throw fail_('Heç olmasa bir rəqəm daxil edin.');

  var stamp = now_(), today = today_();
  var users = rawRows_('Users');
  var logins = {}; users.forEach(function (x) { logins[String(x.login).toLowerCase()] = true; });
  var seq = 1;
  var nextLogin = function () { var l; do { l = 'test' + (seq < 10 ? '0' : '') + seq; seq++; } while (logins[l]); logins[l] = true; return l; };

  // 1) Müəllimlər
  var newU = [];
  var mkTeacher = function () {
    var row = { id: newId_('U'), name: testPerson_(), login: nextLogin(), password: TEST_PASSWORD, role: 'teacher', phone: '',
      permissions: '', theme: 'light', createdAt: stamp, updatedAt: '', deletedAt: '', deletedBy: '', isTest: 'true' };
    newU.push(row); return row;
  };
  for (var i = 0; i < nT; i++) mkTeacher();

  // 2) Tələbələr
  var newS = [];
  var mkStudent = function () {
    var row = { id: newId_('S'), name: testPerson_(), phone: '', parentName: '', parentPhone: '',
      note: '', cardToken: newToken_(), status: 'active', createdAt: stamp, updatedAt: '', deletedAt: '', deletedBy: '', isTest: 'true' };
    newS.push(row); return row;
  };
  for (i = 0; i < nS; i++) mkStudent();

  // 3) Məşğələlər + dərslər + ödənişlər
  var newC = [], newL = [], newP = [], lessonCount = 0, autoT = 0, autoS = 0;
  if (nC) {
    var teacherPool = newU.slice();
    if (!teacherPool.length) teacherPool = rows_('Users').filter(function (x) { return isTrue_(x.isTest) && x.role === 'teacher'; });
    if (!teacherPool.length) { teacherPool = [mkTeacher()]; autoT = 1; }
    var studentPool = newS.slice();
    if (studentPool.length < 2) studentPool = studentPool.concat(rows_('Students').filter(function (x) { return isTrue_(x.isTest); }));
    var need = mix === 'individual' ? 1 : 2;
    while (studentPool.length < need) { studentPool.push(mkStudent()); autoS++; }
    var sp = 0;
    var takeStudents = function (k) {
      var out = [];
      for (var j = 0; j < k && out.length < studentPool.length; j++) {
        var s = studentPool[sp % studentPool.length]; sp++;
        if (out.indexOf(s.id) === -1) out.push(s.id);
      }
      return out;
    };
    for (i = 0; i < nC; i++) {
      var type = mix === 'mixed' ? (i % 3 === 2 ? 'group' : 'individual') : mix;
      if (type === 'group' && studentPool.length < 2) type = 'individual';
      var ids = takeStudents(type === 'group' ? Math.min(studentPool.length, 2 + Math.floor(Math.random() * 4)) : 1);
      if (type === 'group' && ids.length < 2) type = 'individual';
      var N = Math.random() < 0.7 ? 8 : 12;
      var t = teacherPool[i % teacherPool.length];
      var past = withPast && i % 2 === 0;
      var cur = past ? 2 : 1;
      var lessonsNow = Math.min(nL, N);
      var span = Math.max(lessonsNow, 1) * 3;           // cari ayın dərsləri təxminən 3 gündən bir
      var monthStart = daysAgo_(span);
      var c = { id: newId_('C'), title: type === 'group' ? 'Test qrup ' + (i + 1) + ' — ' + pick_(TEST_SUBJECTS) : '', type: type,
        teacherId: t.id, studentIds: ids.join(','), lessonsPerMonth: String(N), monthNo: String(cur), monthStart: monthStart,
        createdAt: stamp, updatedAt: '', deletedAt: '', deletedBy: '', isTest: 'true' };
      newC.push(c);
      var mkLessons = function (month, count, startAgo, spacing) {
        for (var k = 0; k < count; k++) {
          var ago = Math.max(0, startAgo - k * spacing);
          var date = daysAgo_(ago);
          var lessonId = newId_('D');
          var topic = pick_(TEST_TOPICS);
          var markedAt = ago === 0 ? stamp : date + ' 18:' + (10 + Math.floor(Math.random() * 40)) + ':00';
          var anyHeld = false;
          var rows = ids.map(function (sid) {
            var held = Math.random() < 0.86;
            if (held) anyHeld = true;
            return { sid: sid, held: held };
          });
          if (!anyHeld && Math.random() < 0.6) { rows[0].held = true; anyHeld = true; }
          rows.forEach(function (r) {
            newL.push({ id: newId_('A'), lessonId: lessonId, courseId: c.id, monthNo: String(month), date: date, studentId: r.sid,
              status: r.held ? HELD : ABSENT, reason: r.held ? '' : pick_(TEST_REASONS), topic: topic,
              markedBy: t.id, markedAt: markedAt, editedBy: '', editedAt: '' });
          });
          lessonCount++;
        }
      };
      // Keçmiş ay: tam keçirilmiş (N dərs), cari aydan əvvəl
      if (past) mkLessons(1, N, span + 3 + (N - 1) * 3, 3);
      if (lessonsNow) mkLessons(cur, lessonsNow, (lessonsNow - 1) * 3, 3);
      if (withPay) {
        ids.forEach(function (sid, idx) {
          var amount = String(pick_([80, 100, 120, 150]));
          if (past && (idx + i) % 2 === 0) newP.push({ id: newId_('P'), studentId: sid, courseId: c.id, monthNo: '1', amount: amount, date: monthStart, note: 'Test ödənişi', createdBy: u.id, createdAt: stamp });
          if (Math.random() < 0.6) newP.push({ id: newId_('P'), studentId: sid, courseId: c.id, monthNo: String(cur), amount: amount, date: today, note: 'Test ödənişi', createdBy: u.id, createdAt: stamp });
        });
      }
    }
  }

  // Cari ayın dərs sayı aylıq limitdən (8/12) çox ola bilməz — lessonsNow = min(nL, N)
  insertMany_('Users', newU);
  insertMany_('Students', newS);
  insertMany_('Courses', newC);
  insertMany_('Lessons', newL);
  insertMany_('Payments', newP);

  var res = { teachers: newU.length, students: newS.length, courses: newC.length, lessons: lessonCount, payments: newP.length,
    logins: newU.map(function (x) { return x.login; }), password: TEST_PASSWORD, autoTeachers: autoT, autoStudents: autoS };
  log_(u, 'dev', 'Test məlumatları yaratdı',
    res.teachers + ' müəllim, ' + res.students + ' tələbə, ' + res.courses + ' məşğələ, ' + res.lessons + ' dərs, ' + res.payments + ' ödəniş' +
    (withPast ? ' · keçmiş ay ilə' : ''));
  return res;
}

function purgeTestData_(u, req) {
  needDev_(u);
  var sc = testScope_();
  if (sc.conflicts.length) {
    throw fail_('Bu real məşğələlər test müəllimə bağlıdır: ' + sc.conflicts.map(courseLabel_).join(', ') +
      '. Əvvəlcə onlara başqa müəllim təyin edin, sonra yenidən cəhd edin.');
  }
  var counts = testCounts_(sc);
  if (!counts.teachers && !counts.students && !counts.courses) return { removed: counts };
  // Real məşğələlərdən test tələbələri çıxar (qrupun real tələbələri qalır)
  sc.realWithTestStudents.forEach(function (c) {
    var keep = idList_(c.studentIds).filter(function (id) { return !sc.tS[id]; });
    update_('Courses', c, { studentIds: keep.join(','), updatedAt: now_() });
  });
  var rowsOf = function (list) { return list.map(function (r) { return r._row; }); };
  removeRows_('Lessons', rowsOf(sc.lessons));
  removeRows_('Payments', rowsOf(sc.payments));
  removeRows_('Transfers', rowsOf(sc.transfers));
  removeRows_('Surveys', rowsOf(sc.surveys));
  removeRows_('Notifs', rowsOf(sc.notifs));
  removeRows_('AnnSeen', rowsOf(sc.annSeen));
  var objRows = function (map) { return Object.keys(map).map(function (k) { return map[k]._row; }); };
  removeRows_('Courses', objRows(sc.tC));
  removeRows_('Students', objRows(sc.tS));
  removeRows_('Users', objRows(sc.tU));
  log_(u, 'dev', 'Bütün test məlumatlarını sildi',
    counts.teachers + ' müəllim, ' + counts.students + ' tələbə, ' + counts.courses + ' məşğələ, ' + counts.lessons + ' dərs, ' + counts.payments + ' ödəniş' +
    (sc.realWithTestStudents.length ? ' · ' + sc.realWithTestStudents.length + ' real məşğələdən test tələbələri çıxarıldı' : ''));
  return { removed: counts, cleanedReal: sc.realWithTestStudents.length };
}

// ===================== ARXİV =====================
function monthsAgo_(n) {
  var d = new Date();
  d.setMonth(d.getMonth() - n);
  return Utilities.formatDate(d, TIMEZONE, 'yyyy-MM-dd');
}
function archiveRowDate_(r, col) { return String(r[col] || '').slice(0, 10); }
function addDays_(s, days) {
  var t = new Date(String(s).replace(' ', 'T') + TZ_OFFSET).getTime();
  if (isNaN(t)) return '';
  return Utilities.formatDate(new Date(t + days * 864e5), TIMEZONE, 'yyyy-MM-dd');
}

/**
 * Seçilmiş vərəqdə arxivləşəcək sətirlər.
 * p = { cutoff | from/to, userId, type } — userId/type yalnız jurnal üçün.
 * Qorunanlar: aktiv elanlar və hələ açıq olan sorğu linkləri heç vaxt arxivlənmir.
 */
function archiveCandidates_(name, p) {
  var col = ARCHIVE_SHEETS[name];
  if (!col) return [];
  return rawRows_(name).filter(function (r) {
    var d = archiveRowDate_(r, col);
    if (!d) return false;
    if (p.from || p.to) {
      if (p.from && d < p.from) return false;
      if (p.to && d > p.to) return false;
    } else if (!(d < p.cutoff)) return false;
    if (name === 'Logs') {
      if (p.userId && r.userId !== p.userId) return false;
      if (p.type && r.type !== p.type) return false;
    }
    if (name === 'Anns' && (r.active === 'true' || r.active === '1')) return false;
    if (name === 'Surveys' && r.status === 'sent' && ageHours_(r.sentAt) <= SURVEY_TTL_DAYS * 24) return false;
    return true;
  });
}

function devOnly_(u) { if (u.role !== 'developer') throw fail_('Bu əməliyyat yalnız developer üçündür.', 'PERM'); }

function parseArchiveReq_(req) {
  var sheets = (Array.isArray(req.sheets) ? req.sheets : []).map(String).filter(function (s, i, a) { return ARCHIVE_SHEETS[s] && a.indexOf(s) === i; });
  var from = str_(req.from, 10), to = str_(req.to, 10);
  if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) throw fail_('Başlanğıc tarixi düzgün deyil.');
  if (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw fail_('Son tarix düzgün deyil.');
  if (from && to && from > to) throw fail_('Başlanğıc tarixi son tarixdən sonra ola bilməz.');
  var cutoff = null;
  if (!from && !to) {
    var months = Number(req.months) || ARCHIVE_MONTHS;
    if ([3, 6, 12, 24].indexOf(months) === -1) months = ARCHIVE_MONTHS;
    cutoff = monthsAgo_(months);
  }
  return { sheets: sheets, from: from, to: to, cutoff: cutoff, userId: str_(req.userId, 40), type: str_(req.type, 20) };
}
function describeArchive_(p) {
  var s = p.cutoff ? p.cutoff + '-dən köhnə' : (p.from || '…') + ' — ' + (p.to || '…');
  if (p.userId) s += ' · istifadəçi: ' + userName_(p.userId);
  if (p.type) s += ' · növ: ' + p.type;
  return s;
}

function archivePreview_(u, req) {
  devOnly_(u);
  var p = parseArchiveReq_(req);
  var out = p.sheets.map(function (name) {
    return { sheet: name, label: ARCHIVE_LABELS[name], count: archiveCandidates_(name, p).length };
  });
  return { preview: out, total: out.reduce(function (s, x) { return s + x.count; }, 0), describe: describeArchive_(p) };
}

// Arxiv faylı (cari il üzrə) — yoxdursa yaradılır. Hər il yeni fayl: hər faylın öz 10 mln xana limiti var.
function archiveSS_() {
  var cfg = settingGet_('archive') || {};
  var year = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy');
  var ss = null;
  if (cfg[year]) { try { ss = SpreadsheetApp.openByUrl(cfg[year]); } catch (e) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create('Aslan Lessons — Arxiv ' + year);
    cfg[year] = ss.getUrl();
    settingSet_('archive', cfg);
  }
  return ss;
}

// Arxivə yazır. Təkrar yazmır: id artıq arxivdədirsə keçir (yarımçıq qalmış əməliyyat təkrarlananda dublikat olmasın).
function appendArchive_(ss, name, rows) {
  if (!rows.length) return 0;
  var head = SCHEMA[name];
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('A:' + colLetter_(head.length)).setNumberFormat('@');
  }
  var have = {};
  var last = sh.getLastRow();
  if (last >= 2) sh.getRange(2, 1, last - 1, 1).getValues().forEach(function (v) { have[String(v[0])] = true; });
  var keyCol = head[0];
  var data = rows.filter(function (r) { return !have[String(r[keyCol])]; })
    .map(function (r) { return head.map(function (h) { return val_(r[h]); }); });
  if (!data.length) return 0;
  var start = last + 1;
  var need = start + data.length - 1 - sh.getMaxRows();
  if (need > 0) sh.insertRowsAfter(sh.getMaxRows(), need + 50);
  sh.getRange(start, 1, data.length, head.length).setValues(data);
  return data.length;
}

// Bir vərəqi arxivləşdir: əvvəlcə arxivə yaz, sonra işçi cədvəldən sil
function archiveSheet_(name, p, remaining) {
  var rows = archiveCandidates_(name, p);
  if (!rows.length) return { count: 0, left: 0 };
  var batch = rows.slice(0, Math.max(1, remaining));
  var ss = archiveSS_();
  appendArchive_(ss, name, batch);
  // Elanla birlikdə onun «görülüb» qeydləri də köçür
  var seen = [];
  if (name === 'Anns') {
    var ids = {}; batch.forEach(function (a) { ids[a.id] = true; });
    seen = rawRows_('AnnSeen').filter(function (x) { return ids[x.annId]; });
    appendArchive_(ss, 'AnnSeen', seen);
  }
  SpreadsheetApp.flush(); // arxivə yazıldığına əmin ol, sonra sil
  removeRows_(name, batch.map(function (r) { return r._row; }));
  if (seen.length) removeRows_('AnnSeen', seen.map(function (r) { return r._row; }));
  return { count: batch.length, left: rows.length - batch.length };
}

function archiveNow_(u, req) {
  devOnly_(u);
  var p = parseArchiveReq_(req);
  if (!p.sheets.length) throw fail_('Arxivləşəcək bölmə seçin.');
  var results = [], total = 0, left = 0;
  var remaining = ARCHIVE_BATCH;
  p.sheets.forEach(function (name) {
    if (remaining <= 0) { left += archiveCandidates_(name, p).length; return; }
    var r = archiveSheet_(name, p, remaining);
    remaining -= r.count; total += r.count; left += r.left;
    if (r.count) results.push(ARCHIVE_LABELS[name] + ': ' + r.count);
  });
  if (total) log_(u, 'dev', 'Məlumatları arxivləşdirdi', results.join(', ') + (left ? ' · qalan: ' + left : '') + ' · ' + describeArchive_(p));
  return { archived: total, left: left, details: results };
}

// Avto-arxivin özü (kilidsiz) — trigger və developer düyməsi bunu çağırır
function autoArchiveCore_(actor, force) {
  var st = settingGet_('archiveAuto') || {};
  if (!force && st.last && ageHours_(st.last) < AUTO_ARCHIVE_DAYS * 24) return { skipped: true, last: st.last };
  var p = { cutoff: monthsAgo_(ARCHIVE_MONTHS) };
  var results = [], total = 0;
  AUTO_ARCHIVE_SHEETS.forEach(function (name) {
    var done = 0, guard = 0;
    while (guard++ < 20) {
      var r = archiveSheet_(name, p, ARCHIVE_BATCH);
      done += r.count;
      if (!r.count || !r.left) break;
    }
    if (done) results.push(ARCHIVE_LABELS[name] + ': ' + done);
    total += done;
  });
  settingSet_('archiveAuto', { last: now_(), archived: total, by: actor ? actor.name : 'avtomatik' });
  log_(actor || null, actor ? 'dev' : 'system', actor ? 'Avtomatik arxivi əl ilə işə saldı' : 'Avtomatik arxivləşdirmə',
    (results.length ? results.join(', ') : 'köçürüləcək qeyd yox idi') + ' · ' + ARCHIVE_MONTHS + ' aydan köhnə');
  return { archived: total, details: results };
}

/** Trigger: hər ayın 1-də işləyir, amma arxivi yalnız 3 aydan bir edir. */
function autoArchiveQuarterly() {
  withLock_(function () { autoArchiveCore_(null, false); });
}

function archiveAutoNow_(u, req) {
  devOnly_(u);
  return autoArchiveCore_(u, true);
}

function installTriggersRoute_(u, req) {
  devOnly_(u);
  var created = installTriggers_();
  log_(u, 'dev', 'Triggerləri qurdu', created.length ? created.join(', ') : 'hamısı artıq qurulub idi');
  return { created: created, triggers: triggersStatus_() };
}

function archiveInfo_(u, req) {
  if (u.role !== 'developer' && u.role !== 'superadmin') throw fail_('İcazə yoxdur.', 'PERM');
  var cfg = settingGet_('archive') || {};
  var files = Object.keys(cfg).sort().reverse().map(function (y) { return { year: y, url: cfg[y] }; });
  var sections = Object.keys(ARCHIVE_SHEETS).map(function (name) {
    return { sheet: name, label: ARCHIVE_LABELS[name], note: ARCHIVE_NOTES[name] || '', count: rawRows_(name).length,
      auto: AUTO_ARCHIVE_SHEETS.indexOf(name) !== -1 };
  });
  var st = settingGet_('archiveAuto') || {};
  var users = rawRows_('Users').map(function (x) { return { id: x.id, name: x.name + (x.deletedAt ? ' (silinib)' : '') }; })
    .sort(function (a, b) { return a.name.localeCompare(b.name, 'az'); });
  return {
    files: files, sections: sections, locked: ARCHIVE_LOCKED, users: users,
    retentionMonths: ARCHIVE_MONTHS, autoDays: AUTO_ARCHIVE_DAYS,
    autoSheets: AUTO_ARCHIVE_SHEETS.map(function (s) { return ARCHIVE_LABELS[s]; }),
    autoLast: st.last || '', autoLastCount: st.archived == null ? null : st.archived,
    autoNext: st.last ? addDays_(st.last, AUTO_ARCHIVE_DAYS) : '',
    triggers: triggersStatus_()
  };
}
