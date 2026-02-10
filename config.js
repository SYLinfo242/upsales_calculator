// ========== КОНФІГУРАЦІЯ ==========
const API_KEY = 'M2IyOTFjNWM4ODA2OWU0NjU4ZDRkODAxZDVkMTQ4ZGNlMzUzYzc5NQ';
const SHEET_NAME = 'Допродажі';

// ========== РІВНІ МЕНЕДЖЕРІВ ==========
// Для кожного менеджера розраховуємо ЗП на всіх трьох рівнях
const MANAGER_LEVELS = {
  1: {
    name: 'Рівень 1',
    rate: 3,        // % від маржі вхідних замовлень
    bonus: 50,      // % від маржі допродажів/замовлень з тегами
    threshold: 150  // поріг маржі для нарахування бонусу (грн)
  },
  2: {
    name: 'Рівень 2',
    rate: 4,
    bonus: 55,
    threshold: 175
  },
  3: {
    name: 'Рівень 3',
    rate: 5,
    bonus: 60,
    threshold: 200
  }
};

// Константи для зворотної сумісності (використовуються в тестових функціях)
// Беруться з рівня 2 (Middle)
const MARGIN_THRESHOLD = MANAGER_LEVELS[2].threshold;
const BONUS_PERCENTAGE = MANAGER_LEVELS[2].bonus / 100;
const MANAGER_BASE_RATE_PERCENTAGE = MANAGER_LEVELS[2].rate;

const FULL_ORDER_TAGS = ['Стара база', 'Відгук']; // Замовлення з цими тегами рахуємо повністю
// Статуси, які вважаємо скасованими/невдалими і не враховуємо
const CANCELED_STATUS_IDS = [15, 16, 17, 19, 28, 29, 30, 31, 32, 35];

// Налаштування API
const API_BASE_URL = 'https://openapi.keycrm.app/v1';
const API_LIMIT = 50;

// Період: 'last_month', 'this_month', 'this_month_to_yesterday', 'last_30_days', 'custom', 'all'
const DATE_FILTER = 'this_month_to_yesterday'; // Автоматично з першого числа місяця по вчора
const CUSTOM_START_DATE = '2025-12-30 00:00:00'; // Використовується тільки якщо DATE_FILTER = 'custom'
const CUSTOM_END_DATE = '2025-12-30 23:59:59'; // Використовується тільки якщо DATE_FILTER = 'custom'
const DATES_TIMEZONE = 'Europe/Kiev';
const CONVERT_DATES_TO_UTC_FOR_API = true;
