// =============================================================================
// mobile/src/utils/dateTime.ts — Conversão de Fuso Horário Local (UTC -> Device)
// -----------------------------------------------------------------------------
// O QUE: Centraliza o parse de datas ISO 8601 UTC vindas do BFF (ex.:
//        `2026-10-28T14:00:00.000Z`) e a formatação/comparação no fuso horário
//        local real do dispositivo (ex.: `America/Sao_Paulo`, UTC-3).
//
// POR QUE:
//   1. No React Native / Hermes (especialmente Android), métodos legados baseados
//      em POSIX (`date.getHours()`, `date.getDate()`) podem cair em UTC (`GMT`)
//      quando a variável `TZ` nativa não está exportada no processo C, enquanto
//      a API `Intl.DateTimeFormat` / `toLocaleTimeString` / `toLocaleDateString`
//      consulta diretamente a ponte ICU/Java do sistema operacional Android/iOS.
//   2. Comparar o dia civil ("Ontem", "Hoje", "Próximos") pela chave local
//      `YYYY-MM-DD` gerada via ICU evita o bug clássico de meia-noite UTC
//      (ex.: um jogo às 22:00 no Brasil = `01:00Z` do dia seguinte em UTC
//      continuará sendo classificado e exibido corretamente como "Hoje • 22:00").
// =============================================================================

export type LocalDayRelation = 'before' | 'today' | 'after' | 'invalid';

export interface FormattedMatchCardSchedule {
  isToday: boolean;
  /** Data curta local no padrão `DD/MM` (ex.: `"28/10"`). */
  dateLabel: string;
  /** Horário local no padrão 24h `HH:mm` (ex.: `"11:00"`). */
  timeLabel: string;
}

export interface FormattedPreMatchSchedule {
  isToday: boolean;
  /** Data completa local no padrão `DD/MM/YYYY` (ex.: `"28/10/2026"`). */
  datePart: string;
  /** Horário local no padrão 24h `HH:mm` (ex.: `"11:00"`). */
  timePart: string;
}

/**
 * Descobre explicitamente o IANA timeZone configurado no aparelho (ex.:
 * `"America/Sao_Paulo"`) via ICU do Hermes/JSC. Retorna `undefined` apenas se
 * o runtime não expuser `Intl`, deixando o fallback padrão do `Date`.
 */
function resolveDeviceTimeZone(): string | undefined {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && tz.trim().length > 0 ? tz : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Faz o parse seguro de uma string ISO 8601 vinda da API garantindo que
 * timestamps sem sufixo explícito de offset sejam interpretados como UTC (`Z`).
 */
export function parseUtcIsoDate(isoDate: string): Date {
  const trimmed = isoDate.trim();
  if (!trimmed) {
    return new Date(Number.NaN);
  }

  // Se vier apenas `YYYY-MM-DD`, preserva sem forçar horário.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return new Date(`${trimmed}T00:00:00Z`);
  }

  // Normaliza espaço entre data e hora (`2026-10-28 14:00:00` -> `2026-10-28T14:00:00Z`)
  // e garante sufixo `Z` caso não exista `Z` nem offset `+HH:MM` / `-HH:MM`.
  const withT = trimmed.replace(/^(\d{4}-\d{2}-\d{2})\s+/, '$1T');
  const hasExplicitZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(withT);
  return new Date(hasExplicitZone ? withT : `${withT}Z`);
}

/**
 * Extrai `{ year, month, day }` do `Date` no fuso horário local do aparelho
 * usando `Intl.DateTimeFormat` (ICU nativo iOS/Android).
 */
function extractLocalCalendarParts(date: Date): {
  year: string;
  month: string;
  day: string;
} {
  const timeZone = resolveDeviceTimeZone();
  try {
    const parts = new Intl.DateTimeFormat('pt-BR', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);

    const year = parts.find((p) => p.type === 'year')?.value;
    const month = parts.find((p) => p.type === 'month')?.value;
    const day = parts.find((p) => p.type === 'day')?.value;

    if (year && month && day) {
      return {
        year,
        month: month.padStart(2, '0'),
        day: day.padStart(2, '0'),
      };
    }
  } catch {
    // Fallback para getters locais do objeto Date caso `formatToParts` falhe.
  }

  return {
    year: String(date.getFullYear()),
    month: String(date.getMonth() + 1).padStart(2, '0'),
    day: String(date.getDate()).padStart(2, '0'),
  };
}

/**
 * Retorna a chave ordenável `YYYY-MM-DD` correspondente à data civil no fuso
 * horário local do aparelho.
 */
export function getLocalDateKey(date: Date): string {
  const { year, month, day } = extractLocalCalendarParts(date);
  return `${year}-${month}-${day}`;
}

/**
 * Compara um timestamp ISO UTC com o dia de "Hoje" no fuso local do aparelho.
 * Usado tanto nas abas ("Ontem" / "Hoje" / "Próximos") quanto no selo verde "Hoje".
 */
export function compareWithLocalToday(
  isoDate: string,
  referenceNow: Date = new Date(),
): LocalDayRelation {
  const parsed = parseUtcIsoDate(isoDate);
  if (Number.isNaN(parsed.getTime())) {
    return 'invalid';
  }

  const targetKey = getLocalDateKey(parsed);
  const todayKey = getLocalDateKey(referenceNow);

  if (targetKey === todayKey) return 'today';
  return targetKey < todayKey ? 'before' : 'after';
}

/**
 * Formata o horário no fuso local do dispositivo (`HH:mm`) utilizando
 * `toLocaleTimeString` conforme o padrão nativo do React Native.
 */
export function formatLocalTime(isoDate: string): string {
  const date = parseUtcIsoDate(isoDate);
  if (Number.isNaN(date.getTime())) {
    return '--:--';
  }

  const timeZone = resolveDeviceTimeZone();
  try {
    const formatted = date.toLocaleTimeString([], {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    // Alguns locales ICU no Android formatam meia-noite em 24h como "24:00".
    const normalized = formatted.replace(/^24:/, '00:');
    // Extrai estritamente `HH:mm` caso algum locale anexe segundos ou sufixos.
    const match = normalized.match(/(\d{1,2}):(\d{2})/);
    if (match && match[1] && match[2]) {
      return `${match[1].padStart(2, '0')}:${match[2]}`;
    }
    return normalized;
  } catch {
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  }
}

/** Formata uma data ISO UTC para `DD/MM` no fuso horário local do aparelho. */
export function formatLocalDayMonth(isoDate: string): string {
  const date = parseUtcIsoDate(isoDate);
  if (Number.isNaN(date.getTime())) {
    return '--/--';
  }

  const { day, month } = extractLocalCalendarParts(date);
  return `${day}/${month}`;
}

/** Formata uma data ISO UTC para `DD/MM/YYYY` no fuso horário local do aparelho. */
export function formatLocalFullDate(isoDate: string): string {
  const date = parseUtcIsoDate(isoDate);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }

  const { day, month, year } = extractLocalCalendarParts(date);
  return `${day}/${month}/${year}`;
}

/**
 * Formata o agendamento completo para o cabeçalho do `MatchCard` na Home Screen,
 * garantindo que `isToday`, `dateLabel` e `timeLabel` respeitem o fuso local.
 */
export function formatMatchCardSchedule(
  isoDate: string,
  referenceNow: Date = new Date(),
): FormattedMatchCardSchedule {
  const date = parseUtcIsoDate(isoDate);
  if (Number.isNaN(date.getTime())) {
    return {
      isToday: false,
      dateLabel: '--/--',
      timeLabel: '--:--',
    };
  }

  return {
    isToday: getLocalDateKey(date) === getLocalDateKey(referenceNow),
    dateLabel: formatLocalDayMonth(isoDate),
    timeLabel: formatLocalTime(isoDate),
  };
}

/**
 * Formata data e hora agendadas para a tela de detalhes pré-jogo (`PreMatchStats`),
 * sinalizando `isToday` com base na data civil local do aparelho.
 */
export function formatPreMatchSchedule(
  isoDate: string,
  referenceNow: Date = new Date(),
): FormattedPreMatchSchedule | null {
  const date = parseUtcIsoDate(isoDate);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return {
    isToday: getLocalDateKey(date) === getLocalDateKey(referenceNow),
    datePart: formatLocalFullDate(isoDate),
    timePart: formatLocalTime(isoDate),
  };
}
