/**
 * The shipped default ruleset.
 *
 * Ordering matters (first match wins). The important structural decision is
 * that *site* rules come before *browser* rules: a browser is not a category,
 * the page inside it is. Everything below `browser-generic` only sees apps.
 *
 * Coverage notes: this list deliberately over-serves Chinese desktop software
 * (WeChat, DingTalk, Feishu, WPS, Bilibili, Steam-CN titles, ...) because that
 * is where generic Western trackers fail and where the users of this project
 * actually live.
 */

import { BROWSER_STEMS, type CategoryRule } from './rules.ts';

const D = (r: CategoryRule): CategoryRule => r;

/** Rules that only fire when the foreground window belongs to a browser. */
export const SITE_RULES: CategoryRule[] = [
  // --- video / streaming -------------------------------------------------
  D({ id: 'site.video', category: 'entertainment', exe: BROWSER_STEMS, title: 'youtube\\.com|youtube\\b|bilibili|哔哩哔哩|netflix|twitch|爱奇艺|iqiyi|腾讯视频|v\\.qq\\.com|优酷|youku|芒果tv|mgtv|西瓜视频|抖音|douyin|tiktok|disney\\+|hbomax|hulu|prime video|niconico|acfun|a站|虎牙|斗鱼|douyu|huya', note: 'streaming or short-video site' }),
  // --- social ------------------------------------------------------------
  D({ id: 'site.social', category: 'social', exe: BROWSER_STEMS, title: 'twitter\\.com|\\bx\\.com\\b|facebook|instagram|reddit|weibo|微博|小红书|xiaohongshu|tieba|贴吧|threads\\.net|mastodon|bluesky|linkedin|tinder|snapchat', note: 'social feed' }),
  // --- shopping ----------------------------------------------------------
  D({ id: 'site.shopping', category: 'shopping', exe: BROWSER_STEMS, title: 'taobao|淘宝|tmall|天猫|jd\\.com|京东|pinduoduo|拼多多|amazon\\.|ebay|aliexpress|1688|闲鱼|goofish|shein|temu|shopee|lazada|etsy|zara|uniqlo|得物|dewupp', note: 'shopping site' }),
  // --- mail --------------------------------------------------------------
  D({ id: 'site.mail', category: 'communication', exe: BROWSER_STEMS, title: 'mail\\.google|gmail|outlook\\.(live|office|com)|mail\\.qq\\.com|邮箱|mail\\.163|zoho mail|proton ?mail|fastmail', note: 'webmail' }),
  // --- meetings ----------------------------------------------------------
  D({ id: 'site.meeting', category: 'communication', exe: BROWSER_STEMS, title: 'meet\\.google|zoom\\.us|teams\\.microsoft|腾讯会议|voov meeting|飞书会议|lark.*meeting|webex|jitsi', note: 'online meeting' }),
  // --- docs / writing surfaces that are genuinely deep work --------------
  D({ id: 'site.docs-editor', category: 'deep-work', exe: BROWSER_STEMS, title: 'docs\\.google\\.com/document|office\\.com.*(word|excel|powerpoint)|overleaf|腾讯文档|docs\\.qq\\.com|飞书云文档|yuque\\.com|notion\\.so|语雀|石墨文档|shimo\\.im|confluence', note: 'online document editor' }),
  // --- code surfaces -----------------------------------------------------
  D({ id: 'site.code', category: 'deep-work', exe: BROWSER_STEMS, title: 'github|gitlab|gitee|codepen|codesandbox|stackblitz|replit|jsfiddle|colab\\.research|jupyter|observablehq|huggingface\\.co/spaces|vscode\\.dev|gitpod', note: 'code host or online IDE' }),
  // --- learning ----------------------------------------------------------
  D({ id: 'site.learning', category: 'learning', exe: BROWSER_STEMS, title: 'coursera|edx\\.org|udemy|khan ?academy|leetcode|nowcoder|牛客|洛谷|luogu|codeforces|atcoder|慕课|icourse163|学堂在线|xuetangx|bilibili.*(课程|教程|lecture)|arxiv|openreview|paperswithcode|网易公开课|coursera\\.org|duolingo|anki ?web|w3schools|runoob|菜鸟教程|freecodecamp', note: 'course or practice site' }),
  // --- reference / docs --------------------------------------------------
  D({ id: 'site.reference', category: 'reference', exe: BROWSER_STEMS, title: 'stack ?overflow|stackexchange|developer\\.mozilla|mdn|docs\\.|documentation|readthedocs|devdocs|wikipedia|wiki|zhihu|知乎|csdn|博客园|cnblogs|juejin|掘金|segmentfault|grep ?code|sourcegraph|npmjs|pypi|crates\\.io|man ?page|百度百科|baike', note: 'documentation, Q&A or encyclopedia' }),
  // --- AI assistants -----------------------------------------------------
  // General assistants are a *tool*, not a destination. Users who live in one
  // can reclassify it as deep-work with a single user rule.
  D({ id: 'site.ai-chat', category: 'reference', exe: BROWSER_STEMS, title: 'chatgpt|chat\\.openai|claude\\.ai|anthropic|gemini\\.google|bard|deepseek|kimi\\.moonshot|moonshot|通义|tongyi|qwen|豆包|doubao|文心一言|yiyan|perplexity|copilot\\.microsoft|grok|x\\.ai|mistral|poe\\.com|character\\.ai', productivity: 0.6, note: 'AI assistant — often part of real work; reclassify if you disagree' }),
  // --- browser catch-all -------------------------------------------------
  // Must stay LAST among the site rules. A page we cannot place is most likely
  // reading, so it lands in `reference` at a modest 0.4 rather than poisoning
  // the stats as `unknown`.
  D({ id: 'browser.generic', category: 'reference', exe: BROWSER_STEMS, productivity: 0.4, note: 'browser page with no more specific site rule' }),
];

/** Rules that match on the executable (and sometimes the title). */
export const APP_RULES: CategoryRule[] = [
  // =====================================================================
  // Editors & IDEs  ->  deep work
  // =====================================================================
  D({ id: 'dev.vscode', category: 'deep-work', exe: ['code', 'code-insiders', 'codium', 'vscodium', 'cursor', 'windsurf', 'trae', 'positron', 'devenv'], app: ['vs code', 'visual studio code', 'cursor', 'windsurf', 'trae'], note: 'code editor' }),
  D({ id: 'dev.jetbrains', category: 'deep-work', exe: ['idea64', 'pycharm64', 'webstorm64', 'goland64', 'clion64', 'phpstorm64', 'rubymine64', 'rider64', 'datagrip64', 'dataspell64', 'aqua64', 'rustrover64', 'fleet', 'idea', 'pycharm', 'webstorm', 'goland', 'clion'], note: 'JetBrains IDE' }),
  D({ id: 'dev.editors', category: 'deep-work', exe: ['sublime_text', 'notepad++', 'notepad', 'vim', 'nvim', 'neovide', 'gvim', 'emacs', 'zed', 'helix', 'hx', 'atom', 'textmate', 'bbedit', 'ultraedit', 'emeditor', 'everedit', 'sakura'], note: 'text editor' }),
  D({ id: 'dev.terminals', category: 'deep-work', exe: ['windowsterminal', 'wt', 'powershell', 'pwsh', 'cmd', 'conhost', 'openconsole', 'alacritty', 'wezterm', 'kitty', 'mintty', 'git-bash', 'bash', 'zsh', 'fish', 'wsl', 'wslhost', 'mobaxterm', 'tabby', 'hyper', 'terminus', 'iterm2', 'konsole', 'gnome-terminal', 'xterm', 'guake', 'tilix', 'tabby', 'electerm', 'finalshell', 'xshell', 'xftp', 'securecrt', 'putty', 'termius'], note: 'terminal / shell' }),

  // =====================================================================
  // Developer tooling
  // =====================================================================
  D({ id: 'dev.git', category: 'deep-work', exe: ['gitk', 'git-gui', 'github desktop', 'gitkraken', 'sourcetree', 'fork', 'tortoisegitproc', 'tortoisegitmerge', 'lazygit', 'gitui', 'tower'], note: 'version control client' }),
  D({ id: 'dev.docker', category: 'deep-work', exe: ['docker desktop', 'orbstack', 'rancher desktop', 'podman desktop', 'lens'], note: 'container tooling' }),
  D({ id: 'dev.db', category: 'deep-work', exe: ['dbeaver', 'dbeaverce', 'heidisql', 'navicat', 'navicat premium', 'mongodb compass', 'redisinsight', 'pgadmin4', 'pgadmin', 'ssms', 'sqlworkbench', 'beekeeper-studio', 'tableplus', 'datagrip'], note: 'database client' }),
  D({ id: 'dev.api', category: 'deep-work', exe: ['postman', 'insomnia', 'bruno', 'apifox', 'httpie', 'soapui', 'hoppscotch'], note: 'API client' }),
  D({ id: 'dev.engines', category: 'deep-work', exe: ['unity', 'unityhub', 'tuanjie', 'tuanjiehub', 'unrealeditor', 'ue4editor', 'ue5editor', 'godot', 'godot_console', 'rider'], note: 'game engine / realtime 3D' }),
  D({ id: 'dev.latex', category: 'deep-work', exe: ['texstudio', 'texmaker', 'texworks', 'winedt', 'lyx', 'winamp'], note: 'LaTeX authoring' }),
  D({ id: 'dev.scientific', category: 'deep-work', exe: ['matlab', 'mathematica', 'wolframmathematica', 'maple', 'rstudio', 'rgui', 'rterm', 'julia', 'spyder', 'scilab', 'gretl', 'stata', 'spss', 'origin', 'originlab'], note: 'scientific / numerical computing' }),
  D({ id: 'dev.notebooks', category: 'deep-work', exe: ['jupyter-notebook', 'jupyter-lab', 'jupyterlab', 'anaconda navigator', 'conda'], note: 'notebook environment' }),
  D({ id: 'dev.lowlevel', category: 'deep-work', exe: ['x64dbg', 'x32dbg', 'ollydbg', 'ida64', 'ida', 'ghidra', 'windbg', 'windbgx', 'cheatengine', 'procexp', 'procmon', 'wireshark', 'fiddler', 'charles', 'burpsuite', 'mitmproxy', 'dnspy', 'ilspy', 'jadx', 'apktool'], note: 'reverse-engineering / debugging / network analysis' }),
  D({ id: 'dev.notes', category: 'deep-work', exe: ['obsidian', 'logseq', 'typora', 'marktext', 'zettlr', 'joplin', 'trilium', 'roam', 'remnote', 'simplenote', 'notion', 'heptabase', 'anytype', 'siyuan', '思源笔记'], note: 'note-taking / knowledge base' }),
  D({ id: 'dev.virtualization', category: 'deep-work', exe: ['vmware-vmx', 'vmplayer', 'virtualboxvm', 'virtualbox', 'vmware workstation', 'hyper-v', 'qemu', 'utm', 'parallels desktop', 'rdp', 'mstsc', 'remmina', 'anydesk', 'teamviewer', 'rustdesk', 'sunloginclient', '向日葵', 'todesk'], note: 'virtual machine or remote session' }),

  // =====================================================================
  // Office suites
  // =====================================================================
  D({ id: 'office.word', category: 'deep-work', exe: ['winword', 'wps'], app: ['microsoft word', 'word', 'wps writer'], productivity: 0.9, note: 'document authoring' }),
  D({ id: 'office.excel', category: 'deep-work', exe: ['excel', 'et'], app: ['microsoft excel', 'excel', 'wps spreadsheet'], productivity: 0.8, note: 'spreadsheet analysis' }),
  D({ id: 'office.powerpoint', category: 'creative', exe: ['powerpnt', 'wpp'], app: ['microsoft powerpoint', 'powerpoint', 'keynote', 'wps presentation'], note: 'slide authoring' }),
  D({ id: 'office.onenote', category: 'deep-work', exe: ['onenote', 'onenotem'], note: 'note-taking' }),
  D({ id: 'office.pdf', category: 'reference', exe: ['acrobat', 'acrord32', 'acrocef', 'sumatrapdf', 'foxitreader', 'foxit pdf reader', 'pdfxcview', 'pdfexpert', 'preview', 'okular', 'evince', 'zathura', 'mupdf', 'nitro pdf'], note: 'PDF reader' }),

  // =====================================================================
  // Communication
  // =====================================================================
  D({ id: 'com.wechat', category: 'communication', exe: ['wechat', 'wechatappex', 'weixin', 'wechatweb', 'wechatdevtools'], app: ['wechat', '微信'], note: 'WeChat' }),
  D({ id: 'com.qq', category: 'communication', exe: ['qq', 'qqnt', 'tim', 'qqbrowser'], app: ['qq', 'tim', '腾讯qq'], note: 'QQ / TIM' }),
  D({ id: 'com.enterprise-cn', category: 'communication', exe: ['dingtalk', 'wxwork', 'feishu', 'lark', 'bytedance feishu', 'wemeetapp', 'tencentmeeting', 'wecom'], app: ['dingtalk', '钉钉', 'feishu', '飞书', 'lark', 'wecom', '企业微信'], note: 'work chat / meetings' }),
  D({ id: 'com.slack', category: 'communication', exe: ['slack'], note: 'team chat' }),
  D({ id: 'com.discord', category: 'communication', exe: ['discord', 'discordcanary', 'discordptb'], productivity: 0.1, note: 'chat — set to social if you only use it for fun' }),
  D({ id: 'com.telegram', category: 'communication', exe: ['telegram', 'telegramdesktop', 'whatsapp', 'signal', 'messenger', 'line', 'viber', 'element', 'wechatwork'], note: 'messaging' }),
  D({ id: 'com.meetings', category: 'communication', exe: ['zoom', 'cptHost', 'teams', 'ms-teams', 'webexmta', 'webex', 'bluejeans', 'gotomeeting'], note: 'video meeting' }),
  D({ id: 'com.mail', category: 'communication', exe: ['outlook', 'thunderbird', 'foxmail', 'mailspring', 'spark', 'airmail', 'em client', 'mailbird'], note: 'mail client' }),
  D({ id: 'com.feishu-doc', category: 'communication', exe: ['lark'], note: 'Feishu suite' }),

  // =====================================================================
  // Creative production
  // =====================================================================
  D({ id: 'creative.design', category: 'creative', exe: ['photoshop', 'illustrator', 'indesign', 'lightroom', 'afterfx', 'premiere', 'animate', 'gimp', 'krita', 'inkscape', 'figma', 'figma_agent', 'sketch', 'adobexd', 'coreldrw', 'coreldraw', 'affinity designer', 'affinity photo', 'affinity publisher', 'canva', 'paint.net', 'photopea', 'procreate', 'clipstudiopaint', 'sai2', 'sai', 'medibang', 'krita'], note: 'graphics / design' }),
  D({ id: 'creative.video', category: 'creative', exe: ['davinci resolve', 'resolve', 'vegas180', 'vegas', 'capcut', 'jianyingpro', '剪映', 'shotcut', 'kdenlive', 'openshot', 'obs64', 'obs32', 'obs', 'streamlabs obs', 'camtasia', 'bandicam', 'screenpal'], note: 'video editing / capture' }),
  D({ id: 'creative.audio', category: 'creative', exe: ['fl64', 'flstudio', 'ableton live', 'ableton', 'cubase', 'nuendo', 'reaper', 'studio one', 'logic', 'garageband', 'audition', 'audacity', 'reason', 'bitwig studio', 'presonus studio one'], note: 'audio production' }),
  D({ id: 'creative.3d', category: 'creative', exe: ['blender', 'maya', '3dsmax', 'fusion360', 'solidworks', 'autocad', 'acad', 'sketchup', 'rhino', 'cinema 4d', 'c4d', 'houdini', 'zbrush', 'substance painter', 'substance designer', 'motionbuilder'], note: '3D / CAD' }),

  // =====================================================================
  // Learning
  // =====================================================================
  D({ id: 'learn.anki', category: 'learning', exe: ['anki', 'anki.exe'], note: 'spaced repetition' }),
  D({ id: 'learn.cn-apps', category: 'learning', exe: ['chaoxing', 'xuexitong', '学习通', 'zhihuishu', '智慧树', 'icourse163', 'mooc', '得到', 'dedao', 'bilibili'], note: 'course platform' }),
  D({ id: 'learn.readers', category: 'learning', exe: ['calibre', 'calibre-ebook-viewer', 'koreader', 'foliate', 'kindle', 'amazon kindle', 'wpspdf', 'neatreader', 'readera'], note: 'e-book reader' }),

  // =====================================================================
  // Social
  // =====================================================================
  D({ id: 'social.apps', category: 'social', exe: ['weibo', 'weibodesktop', 'xiaohongshu', 'rednote', 'douyin', 'tiktok', 'instagram', 'twitter', 'x', 'facebook', 'reddit', 'linkedin', 'snapchat', 'pinterest', 'tumblr', 'mastodon', 'bsky', 'threads'], note: 'social app' }),

  // =====================================================================
  // Entertainment
  // =====================================================================
  D({ id: 'fun.games', category: 'entertainment', exe: ['steam', 'steamwebhelper', 'epicgameslauncher', 'battle.net', 'riotclientservices', 'leagueclient', 'league of legends', 'valorant', 'genshinimpact', 'yuanshen', '原神', 'starrail', 'honkaistarrail', 'zenlesszonezero', 'minecraft', 'javaw', 'cs2', 'csgo', 'dota2', 'overwatch', 'wow', 'ffxiv_dx11', 'gta5', 'rdr2', 'eldenring', 'palworld', 'wegame', 'netease games', 'ubisoftconnect', 'eadesktop', 'gog galaxy', 'rockstargameslauncher', 'paradox launcher'], note: 'game or game launcher' }),
  D({ id: 'fun.music', category: 'entertainment', exe: ['spotify', 'cloudmusic', '网易云音乐', 'qqmusic', 'kugou', 'kuwo', 'foobar2000', 'musicbee', 'itunes', 'music', 'aimp', 'groove music', 'audirvana', 'tidal', 'deezer'], productivity: -0.2, note: 'music player (often background — treated as non-work)' }),
  D({ id: 'fun.video-players', category: 'entertainment', exe: ['vlc', 'potplayermini64', 'potplayermini', 'mpv', 'mpc-hc64', 'mpc-hc', 'mpc-be64', 'kmplayer', 'gomplayer', 'iqiyi', 'qyclient', 'youku', 'tencentvideo', 'qqlive', 'mgtv', 'bililive', 'huya', 'douyu', 'kmplayer64'], note: 'video player / streaming client' }),
  D({ id: 'fun.readers-manga', category: 'entertainment', exe: ['comicrack', 'cdisplayex', 'yacreader', 'tachidesk'], note: 'comic / manga reader' }),

  // =====================================================================
  // Shopping
  // =====================================================================
  D({ id: 'shop.apps', category: 'shopping', exe: ['taobao', 'tmall', 'aliworkbench', 'jd', 'jingdong', 'pinduoduo', 'amazon', 'ebay', 'aliexpress', 'shopee', 'lazada', 'temu', 'shein', 'goofish', '咸鱼', 'dewu', '得物'], note: 'shopping app' }),

  // =====================================================================
  // Admin / system utilities
  // =====================================================================
  D({ id: 'admin.files', category: 'admin', exe: ['explorer', 'finder', 'nautilus', 'dolphin', 'thunar', 'totalcmd', 'totalcmd64', 'doublecmd', 'xyplorer', 'files', 'dopus', 'onecommander'], note: 'file manager' }),
  D({ id: 'admin.archivers', category: 'admin', exe: ['7zfm', 'winrar', 'bandizip', 'winzip', 'peazip', 'haozip', '360zip', 'nanazip'], note: 'archive tool' }),
  D({ id: 'admin.uninstallers', category: 'admin', exe: ['ccleaner', 'geek', 'geek64', 'iobituninstaller', 'revo', 'wisecare365', 'dism++', 'advanced systemcare'], note: 'system maintenance' }),
  D({ id: 'admin.downloaders', category: 'admin', exe: ['qbittorrent', 'utorrent', 'transmission', 'deluge', 'idman', 'thunder', 'xunlei', 'motrix', 'aria2', 'free download manager', 'fdm'], note: 'download manager' }),
  D({ id: 'admin.screenshot', category: 'admin', exe: ['snipaste', 'sharex', 'greenshot', 'lightshot', 'pixpin', 'faststone capture', 'flameshot', 'snippingtool', 'screensketch'], note: 'screenshot / annotation' }),
  D({ id: 'admin.system-settings', category: 'admin', exe: ['systemsettings', 'control', 'mmc', 'taskmgr', 'regedit', 'services', 'diskmgmt', 'devmgmt', 'compmgmt', 'eventvwr', 'perfmon', 'cleanmgr', 'msconfig', 'computerdefaults', 'applications'], note: 'OS settings / management' }),
  D({ id: 'admin.installers', category: 'admin', exe: ['setup', 'install', 'installer', 'msiexec', 'uninstall', 'update', 'updater', 'winget', 'choco', 'scoop'], note: 'installer or updater' }),
  D({ id: 'admin.drivers', category: 'admin', exe: ['nvcontainer', 'nvcplui', 'radeonsoftware', 'igfxem', 'geforcenow', 'msi afterburner', 'hwinfo64', 'cpu-z', 'gpuz', 'crystaldiskinfo', 'aida64', 'ryzen master'], note: 'hardware / driver utility' }),
  D({ id: 'admin.input-methods', category: 'admin', exe: ['sogouinput', 'sgtool', 'qqpinyin', 'baiduip', 'ctfmon', 'chsime', 'textinputhost'], note: 'input method (background)' }),
  D({ id: 'admin.todo', category: 'admin', exe: ['todo', 'todoist', 'ticktick', '滴答清单', 'microsoft to do', 'things', 'omnifocus', 'habitica', 'notion calendar'], note: 'task manager' }),
  D({ id: 'admin.calendar', category: 'communication', exe: ['outlook', 'calendar', 'fantastical', 'sunbird'], note: 'calendar' }),

  // =====================================================================
  // System / OS plumbing
  // =====================================================================
  D({ id: 'sys.shell', category: 'system', exe: ['dwm', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'svchost', 'smss', 'fontdrvhost', 'sihost', 'shellexperiencehost', 'startmenuexperiencehost', 'searchhost', 'searchapp', 'runtimebroker', 'taskhostw', 'dllhost', 'ctfmon', 'spoolsv', 'securityhealthsystray', 'securityhealthservice', 'msmpeng', 'nissrv', 'widgets', 'widgetservice', 'useroobebroker', 'lockapp', 'logonui', 'consent', 'sppsvc', 'audiodg', 'registry', 'memory compression', 'system', 'system idle process', 'idle', 'windowserver', 'loginwindow', 'launchd', 'systemd', 'gnome-shell', 'kwin_x11', 'kwin_wayland', 'mutter', 'plasmashell', 'xfwm4', 'explorer.exe'], note: 'operating system component' }),
  D({ id: 'sys.lock', category: 'idle', exe: ['logonui', 'lockapp', 'screensaver', 'xscreensaver', 'gnome-screensaver', 'betterlockscreen'], note: 'screen locked' }),
];

export const DEFAULT_RULES: CategoryRule[] = [...SITE_RULES, ...APP_RULES];

/** Guard against accidental duplicate ids, which would silently shadow rules. */
export function findDuplicateRuleIds(rules: readonly CategoryRule[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const r of rules) {
    if (seen.has(r.id)) dupes.add(r.id);
    seen.add(r.id);
  }
  return [...dupes];
}
