const REPOSITORY_URL = "https://github.com/sungikim/Calm-Tasks";

document.querySelectorAll("[data-repo-link]").forEach(link => {
  link.href = REPOSITORY_URL;
});

document.querySelectorAll("[data-release-link]").forEach(link => {
  link.href = `${REPOSITORY_URL}/releases/latest`;
});

document.querySelectorAll("[data-readme-link]").forEach(link => {
  link.href = `${REPOSITORY_URL}#readme`;
});

const korean = {
  "nav.features": "기능",
  "nav.views": "보기",
  "nav.markdown": "마크다운",
  "hero.title": "Calm Tasks<br><span>for Obsidian.</span>",
  "hero.lede": "Calm Tasks는 볼트 전체의 체크박스 할 일을 모아주는 Obsidian 플러그인입니다. 원문은 Markdown에 둔 채 날짜, 우선순위 또는 사용자 그룹별로 확인할 수 있습니다.",
  "hero.download": "다운로드",
  "hero.source": "GitHub 소스",
  "hero.meta.plugin": "Obsidian 플러그인",
  "hero.meta.markdown": "Markdown 파일",
  "hero.meta.local": "로컬 볼트",
  "overview.eyebrow": "Markdown 입력, 할 일 보기",
  "overview.title": "할 일은 Markdown에 남습니다.",
  "overview.copy": "프로젝트 노트, 회의록, Daily Note에 평범한 체크박스 할 일을 작성하세요. Calm Tasks는 기본 파일 형식을 바꾸지 않고 한곳에 모아줍니다.",
  "overview.collect.title": "볼트 전체에서 모으기",
  "overview.collect.copy": "프로젝트 파일, 영역 노트, Daily Note의 할 일이 하나의 플러그인 화면에 나타납니다. 각 행에서 원본 파일명도 확인할 수 있습니다.",
  "overview.groups.title": "나만의 그룹 사용",
  "overview.groups.copy": "Inbox와 이름을 붙인 그룹을 만들고 수동으로 순서를 정할 수 있습니다. 원본 텍스트는 Markdown에 그대로 남습니다.",
  "video.eyebrow": "개요",
  "video.title": "짧은 사용 영상.",
  "video.copy": "할 일을 모으고 편집하고 완료하는 주요 흐름을 짧게 보여줍니다.",
  "video.item.open": "Calm Tasks 화면 열기",
  "video.item.switch": "세 가지 보기 전환하기",
  "video.item.edit": "할 일 편집, 이동, 완료하기",
  "video.placeholder": "제품 소개 영상",
  "views.eyebrow": "보기",
  "views.title": "Agenda, Priority, All 보기.",
  "views.copy": "All에서는 그룹과 수동 순서를 관리합니다. Agenda와 Priority는 같은 할 일을 다른 기준으로 다시 정리합니다.",
  "views.agenda.copy": "Today, Tomorrow와 이후 날짜를 시간순 구역으로 확인합니다.",
  "views.priority.copy": "A–D 우선순위와 우선순위가 없는 None 항목을 확인합니다.",
  "notes.eyebrow": "일반 Markdown 노트",
  "notes.title": "노트에서도 할 일 메타데이터가 보입니다.",
  "notes.copy": "전용 할 일 화면뿐 아니라 일반 Markdown 노트에서도 날짜와 A–D 우선순위를 강조할 수 있습니다. 플러그인 설정에서 강조 표시를 끌 수도 있습니다.",
  "notes.daily": "Daily Note의 할 일도 같은 화면에 모입니다. 선택 옵션을 켜면 날짜 노트 사이로 이동한 할 일의 All 그룹과 순서를 유지할 수 있습니다.",
  "tools.eyebrow": "집중 도구",
  "tools.title": "필터를 저장하고 세부 정보를 엽니다.",
  "tools.filters.title": "Smart Filters",
  "tools.filters.copy": "상태, 날짜, 태그, 키워드 필터를 조합하고 자주 쓰는 조건을 탭으로 저장합니다.",
  "tools.details.title": "Details panel",
  "tools.details.copy": "오른쪽 또는 아래쪽에 세부 패널을 열어 제목, 날짜, 우선순위, 태그, 원본 파일과 노트를 편집합니다.",
  "cta.title": "TO-DO 관리를 위한 옵시디언 플러그인",
  "cta.copy": "무료로 사용할 수 있습니다. 주로 Minimal 테마에서 테스트했습니다.",
  "cta.download": "Calm Tasks 다운로드",
  "cta.support": "개발 후원하기",
  "footer.tagline": "Markdown 할 일을 위한 Obsidian 플러그인.",
  "footer.docs": "문서",
  "footer.note": "평범한 Markdown을 위해 만들었습니다. 주로 Minimal 테마에서 테스트했습니다.",
  "modal.title": "확대된 스크린샷",
  "modal.close": "닫기"
};

const englishText = new Map();
const englishHtml = new Map();
document.querySelectorAll("[data-i18n]").forEach(element => englishText.set(element, element.textContent ?? ""));
document.querySelectorAll("[data-i18n-html]").forEach(element => englishHtml.set(element, element.innerHTML));

const languageToggle = document.querySelector("[data-language-toggle]");
const languageMenu = document.querySelector("[data-language-menu]");
const languageOptions = [...document.querySelectorAll("[data-language-option]")];
const pageMetadata = {
  en: {
    title: "Calm Tasks — A quiet task workspace for Obsidian",
    description: "Calm Tasks is an Obsidian plugin that collects Markdown checkbox tasks into Agenda, Priority, and grouped views.",
    ogTitle: "Calm Tasks for Obsidian",
    ogDescription: "An Obsidian plugin for reviewing Markdown checkbox tasks by date, priority, or custom group."
  },
  ko: {
    title: "Calm Tasks — Obsidian을 위한 차분한 할 일 화면",
    description: "Calm Tasks는 Markdown 체크박스 할 일을 Agenda, Priority와 사용자 그룹별로 모아주는 Obsidian 플러그인입니다.",
    ogTitle: "Obsidian용 Calm Tasks",
    ogDescription: "Markdown 체크박스 할 일을 날짜, 우선순위 또는 사용자 그룹별로 확인하는 Obsidian 플러그인입니다."
  }
};

const setLanguage = language => {
  const nextLanguage = language === "ko" ? "ko" : "en";
  document.documentElement.lang = nextLanguage;
  document.querySelectorAll("[data-i18n]").forEach(element => {
    const key = element.dataset.i18n;
    element.textContent = nextLanguage === "ko" && korean[key] ? korean[key] : englishText.get(element);
  });
  document.querySelectorAll("[data-i18n-html]").forEach(element => {
    const key = element.dataset.i18nHtml;
    element.innerHTML = nextLanguage === "ko" && korean[key] ? korean[key] : englishHtml.get(element);
  });

  const metadata = pageMetadata[nextLanguage];
  document.title = metadata.title;
  document.querySelector('meta[name="description"]')?.setAttribute("content", metadata.description);
  document.querySelector('meta[property="og:title"]')?.setAttribute("content", metadata.ogTitle);
  document.querySelector('meta[property="og:description"]')?.setAttribute("content", metadata.ogDescription);

  if (languageToggle) {
    languageToggle.setAttribute("aria-label", nextLanguage === "ko" ? "언어 선택" : "Choose language");
  }
  languageOptions.forEach(option => {
    option.setAttribute("aria-checked", String(option.dataset.languageOption === nextLanguage));
  });
  try { localStorage.setItem("calm-tasks-language", nextLanguage); } catch {}
};

let initialLanguage = "en";
try {
  const savedLanguage = localStorage.getItem("calm-tasks-language");
  if (savedLanguage === "en" || savedLanguage === "ko") {
    initialLanguage = savedLanguage;
  } else {
    const browserUsesKorean = (navigator.languages ?? [navigator.language])
      .some(language => language?.toLowerCase().startsWith("ko"));
    const timeZoneIsKorea = Intl.DateTimeFormat().resolvedOptions().timeZone === "Asia/Seoul";
    initialLanguage = browserUsesKorean || timeZoneIsKorea ? "ko" : "en";
  }
} catch {}
setLanguage(initialLanguage);

const closeLanguageMenu = () => {
  if (!languageMenu || !languageToggle) return;
  languageMenu.hidden = true;
  languageToggle.setAttribute("aria-expanded", "false");
};

languageToggle?.addEventListener("click", event => {
  event.stopPropagation();
  if (!languageMenu) return;
  const willOpen = languageMenu.hidden;
  languageMenu.hidden = !willOpen;
  languageToggle.setAttribute("aria-expanded", String(willOpen));
  if (willOpen) {
    languageOptions.find(option => option.dataset.languageOption === document.documentElement.lang)?.focus();
  }
});

languageOptions.forEach(option => {
  option.addEventListener("click", () => {
    setLanguage(option.dataset.languageOption);
    closeLanguageMenu();
    languageToggle?.focus();
  });
});

document.addEventListener("click", event => {
  if (!(event.target instanceof Element) || !event.target.closest(".language-picker")) closeLanguageMenu();
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape" && languageMenu && !languageMenu.hidden) {
    closeLanguageMenu();
    languageToggle?.focus();
  }
});

const imageModal = document.querySelector("[data-image-modal]");
const imageModalImage = document.querySelector("[data-image-modal-image]");
const imageModalClose = document.querySelector("[data-image-modal-close]");

const closeImageModal = () => {
  if (imageModal?.open) imageModal.close();
};

const openImageModal = image => {
  if (!imageModal || !imageModalImage) return;
  imageModalImage.src = image.currentSrc || image.src;
  imageModalImage.alt = image.alt;
  imageModal.showModal();
  imageModalClose?.focus();
};

imageModalClose?.addEventListener("click", closeImageModal);
imageModalImage?.addEventListener("click", closeImageModal);
imageModal?.addEventListener("click", event => {
  if (event.target === imageModal) closeImageModal();
});

document.querySelectorAll("[data-image-src]").forEach(frame => {
  const image = new Image();
  image.alt = frame.dataset.imageAlt ?? "Calm Tasks screenshot";
  image.decoding = "async";
  image.loading = frame.closest(".hero") ? "eager" : "lazy";
  image.tabIndex = 0;
  image.setAttribute("role", "button");
  image.setAttribute("aria-label", `Enlarge screenshot: ${image.alt}`);
  if (frame.closest(".hero")) image.fetchPriority = "high";
  image.addEventListener("load", () => {
    frame.classList.add("has-media");
  });
  image.addEventListener("error", () => image.remove());
  image.addEventListener("click", () => openImageModal(image));
  image.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openImageModal(image);
    }
  });
  frame.append(image);
  image.src = frame.dataset.imageSrc;
});

document.querySelectorAll("[data-video-src]").forEach(frame => {
  const video = document.createElement("video");
  video.controls = true;
  video.preload = "metadata";
  video.playsInline = true;
  video.setAttribute("aria-label", "Calm Tasks product overview video");
  const poster = frame.dataset.videoPoster;
  if (poster) video.poster = poster;
  video.addEventListener("loadedmetadata", () => {
    frame.append(video);
    frame.classList.add("has-media");
  });
  video.src = frame.dataset.videoSrc;
});
