/**
 * Скрипт для розрахунку маржі та бонусів менеджерів з допродажів KEYCRM
 * 
 * Використовує офіційний OpenAPI KEYCRM: https://openapi.keycrm.app/v1
 * Документація: https://keycrm.s3.eu-central-1.amazonaws.com/static/open-api.yml
 * 
 * Інструкція з налаштування:
 * 1. Відкрийте Google Таблицю
 * 2. Перейдіть до Розширення > Apps Script
 * 3. Вставте цей код
 * 4. Налаштуйте константи внизу файлу (API_KEY)
 * 5. Запустіть функцію main() або налаштуйте тригер
 */

// ========== ОСНОВНА ФУНКЦІЯ ==========
/**
 * Головна функція для обробки допродажів
 */
function main() {
  try {
    const dateRange = getDateRange(DATE_FILTER);
    const { upsales, incomingOrders } = fetchOrdersFromKeyCRM(dateRange);
    
    if ((!upsales || upsales.length === 0) && (!incomingOrders || incomingOrders.length === 0)) {
      Logger.log('Замовлення не знайдено за вказаний період');
      return;
    }
    
    // Обробляємо ВСІ замовлення (допродажі + з тегами + вхідні) та записуємо в таблиці "Розрахунок МП MM.YY"
    const allResults = processAndWriteAllOrdersToPremiya(upsales || [], incomingOrders || []);
    
    // Записуємо підсумок (ставка + бонус) в єдину таблицю "Виконання MM.YYYY"
    // Всі дані беруться з allResults (таблиця "Розрахунок МП"), без подвійного розрахунку
    writeManagerSummaryToPerformanceSheets(allResults);
    
    const upsalesCount = upsales ? upsales.length : 0;
    const incomingCount = incomingOrders ? incomingOrders.length : 0;
    Logger.log(`✅ Обробка завершена: ${upsalesCount} позицій для премій та ${incomingCount} вхідних позицій`);
    
  } catch (error) {
    Logger.log('Помилка: ' + error.toString());
    throw error;
  }
}

// ========== РОБОТА З KEYCRM API ==========
/**
 * Отримує всі замовлення з KEYCRM і розбиває їх на:
 * - upsales: допродажі та замовлення з тегами (для премій)
 * - incomingOrders: вхідні замовлення (без спецтегів і без допродажів) для ставки 1.5%
 * Використовує офіційний OpenAPI KEYCRM: https://openapi.keycrm.app/v1
 * @param {Object} dateRange - Об'єкт з полями start та end для фільтрації за датою (опціонально)
 * @returns {Object} Об'єкт { upsales: Array, incomingOrders: Array }
 */
function fetchOrdersFromKeyCRM(dateRange) {
  const url = `${API_BASE_URL}/order`;
  
  const options = {
    'method': 'get',
    'headers': {
      'Authorization': `Bearer ${API_KEY}`,
      'Accept': 'application/json'
    },
    'muteHttpExceptions': true
  };
  
  let allUpsales = [];
  let incomingOrders = [];
  let page = 1;
  let hasMore = true;
  
  while (hasMore) {
    try {
      const params = [
        `page=${page}`,
        `limit=${API_LIMIT}`,
        'include=products.offer,manager,tags,status'
      ];
      
      if (dateRange && dateRange.start && dateRange.end) {
        const dateFilter = `${dateRange.start}, ${dateRange.end}`;
        params.push(`filter[created_between]=${encodeURIComponent(dateFilter)}`);
      }
      
      const requestUrl = `${url}?${params.join('&')}`;
      const response = UrlFetchApp.fetch(requestUrl, options);
      const responseCode = response.getResponseCode();
      const responseText = response.getContentText();
      
      if (responseCode !== 200) {
        Logger.log(`❌ Помилка API: ${responseCode}`);
        if (responseCode === 401) {
          throw new Error('Помилка авторизації. Перевірте API ключ.');
        }
        break;
      }
      
      let data;
      try {
        data = JSON.parse(responseText);
      } catch (parseError) {
        Logger.log(`❌ Помилка парсингу JSON: ${parseError.toString()}`);
        throw parseError;
      }
      
      let orders = [];
      if (data.data && Array.isArray(data.data)) {
        orders = data.data;
      } else if (Array.isArray(data)) {
        orders = data;
      } else {
        Logger.log('Невідома структура відповіді API');
        break;
      }
      
      orders.forEach((order) => {
        const statusId = parseInt(order.status?.id || order.status_id || 0, 10);
        const statusGroupId = order.status?.group_id ? parseInt(order.status.group_id, 10) : null;
        if ((statusGroupId && statusGroupId === 6) || (statusId && CANCELED_STATUS_IDS.indexOf(statusId) !== -1)) {
          return; // Пропускаємо скасовані / невдалі замовлення
        }

        const managerId = order.manager?.id || order.manager_id || null;
        const rawManagerName = order.manager?.full_name || order.manager?.name || order.manager_name || 'Невідомий менеджер';
        const { displayName: managerName, key: managerKey } = normalizeManagerName(rawManagerName);
        
        // Перевіряємо, чи замовлення має один із спецтегів (Стара база, Відгук тощо)
        const matchedSpecialTag = getOrderTagName(order, FULL_ORDER_TAGS);
        const hasSpecialTag = Boolean(matchedSpecialTag);
        
        const productsArray = Array.isArray(order.products) ? order.products : [];
        const orderTotalDiscount = parseFloat(order.total_discount || 0);
        
        // Якщо замовлення має спеціальний тег, рахуємо ВСІ товари як повторне замовлення
        if (hasSpecialTag) {
          // Проходимо по всіх товарах в замовленні
          const orderProducts = [];
          let totalOrderValue = 0;
          
          productsArray.forEach(product => {
            const quantity = parseFloat(product.quantity || 1);
            const priceSold = getProductPriceSold(product);
            const purchasedPrice = getProductPurchasedPrice(product);
            const productDiscount = parseFloat(product.total_discount || 0);

            if (priceSold > 0) {
              const productTotalValue = priceSold * quantity;
              totalOrderValue += productTotalValue;
              const productMargin = (priceSold - purchasedPrice) * quantity;

              orderProducts.push({
                orderId: order.id,
                productId: product.id || product.product_id || order.id,
                name: getProductName(product),
                priceSold: priceSold,
                purchasedPrice: purchasedPrice,
                quantity: quantity,
                productDiscount: productDiscount,
                productMargin: productMargin,
                productTotalValue: productTotalValue
              });
            }
          });
          
          // Розподіляємо знижку замовлення пропорційно до ціни продажу кожного товару
          // grand_total вже містить знижку на замовлення, тому розраховуємо різницю
          const grandTotal = parseFloat(order.grand_total || 0);
          const actualOrderDiscount = totalOrderValue > grandTotal ? totalOrderValue - grandTotal : 0;
          
          let totalMargin = 0;
          orderProducts.forEach(product => {
            const orderDiscountPart = totalOrderValue > 0 
              ? actualOrderDiscount * (product.productTotalValue / totalOrderValue)
              : 0;
            const finalMargin = product.productMargin - orderDiscountPart;
            totalMargin += finalMargin;
            
            allUpsales.push({
              orderId: order.id,
              upsellId: product.productId,
              name: product.name,
              salePrice: product.priceSold * product.quantity,
              costPrice: product.purchasedPrice * product.quantity + orderDiscountPart,
              managerId: managerId,
              managerName: managerName,
              managerKey: managerKey,
              date: order.created_at || new Date().toISOString(),
              quantity: product.quantity,
              isSpecialTag: true,
              specialTagName: matchedSpecialTag || 'Спеціальний тег',
              productDiscount: product.productDiscount,
              orderDiscountPart: orderDiscountPart,
              margin: finalMargin
            });
          });
        } else {
          // Якщо немає тегів, обробляємо товари окремо: допродажі → бонуси, стандартні → вхідні
          let totalUpsellValue = 0;
          const upsellProducts = [];

          productsArray.forEach(product => {
            const quantity = parseFloat(product.quantity || 1);
            const priceSold = getProductPriceSold(product);

            if (priceSold <= 0) return;

            const purchasedPrice = getProductPurchasedPrice(product);
            const productMargin = (priceSold - purchasedPrice) * quantity;

            if (isProductUpsell(product)) {
              // Допродаж - рахуємо маржу
              const productDiscount = parseFloat(product.total_discount || 0);
              const productTotalValue = priceSold * quantity;
              totalUpsellValue += productTotalValue;

              upsellProducts.push({
                orderId: order.id,
                productId: product.id || product.product_id || order.id,
                name: getProductName(product, 'Невідома допродажа'),
                priceSold: priceSold,
                purchasedPrice: purchasedPrice,
                quantity: quantity,
                productDiscount: productDiscount,
                productMargin: productMargin,
                productTotalValue: productTotalValue
              });
            } else {
              // Вхідний товар (не допродаж) - для ставки 3% від маржі
              incomingOrders.push({
                orderId: order.id,
                name: getProductName(product, 'Вхідне замовлення'),
                salePrice: priceSold,
                purchasedPrice: purchasedPrice,
                quantity: quantity,
                productMargin: productMargin,
                managerId: managerId,
                managerName: managerName,
                managerKey: managerKey,
                date: order.created_at || new Date().toISOString(),
                isSpecialTag: false,
                grandTotal: parseFloat(order.grand_total || 0),
                totalUpsellValue: totalUpsellValue
              });
            }
          });
          
          // Знижка на замовлення НЕ застосовується до допродажів
          // Маржа допродажів = ціна продажу - ціна закупівлі (без знижки на замовлення)
          const grandTotal = parseFloat(order.grand_total || 0);
          
          upsellProducts.forEach(product => {
            // Маржа = ціна продажу - ціна закупівлі (без знижки на замовлення)
            const finalMargin = product.productMargin;
            
            allUpsales.push({
              orderId: order.id,
              upsellId: product.productId,
              name: product.name,
              salePrice: product.priceSold * product.quantity,
              costPrice: product.purchasedPrice * product.quantity, // БЕЗ orderDiscountPart
              managerId: managerId,
              managerName: managerName,
              managerKey: managerKey,
              date: order.created_at || new Date().toISOString(),
              quantity: product.quantity,
              isSpecialTag: false,
              productDiscount: product.productDiscount,
              orderDiscountPart: 0, // Знижка не застосовується
              margin: finalMargin // БЕЗ віднімання orderDiscountPart
            });
          });
        }
      });
      
      if (data.meta) {
        const currentPage = data.meta.current_page || page;
        const lastPage = data.meta.last_page;
        const total = data.meta.total || 0;

        if (lastPage !== undefined && lastPage !== null && total > 0) {
          hasMore = currentPage < lastPage;
        } else {
          hasMore = orders.length > 0;
        }
      } else {
        hasMore = orders.length > 0;
      }
      
      page++;
      
      if (page > 1000) {
        Logger.log('Досягнуто максимум сторінок (1000)');
        break;
      }

      if (hasMore) {
        Utilities.sleep(1100);
      }
      
    } catch (error) {
      Logger.log(`Помилка при отриманні сторінки ${page}: ${error.toString()}`);
      hasMore = false;
    }
  }
  
  return {
    upsales: allUpsales,
    incomingOrders: incomingOrders
  };
}

// ========== ОБРОБКА ДАНИХ ==========
/**
 * Обробляє допродажі та розраховує маржу та бонуси
 * Якщо в одному замовленні кілька допродажів, їх суми та собівартості складаються
 * Бонус розраховується від загальної суми допродажів в замовленні
 * @param {Array} upsales - Масив допродажів
 * @returns {Array} Масив оброблених результатів
 */
function processUpsales(upsales) {
  const results = [];
  const managerTotals = {};
  const ordersMap = {};

  upsales.forEach((upsell) => {
    const orderId = upsell.orderId;
    const quantity = upsell.quantity || 1;
    const productSalePrice = upsell.salePrice || 0;
    const productCostPrice = upsell.costPrice || 0;
    
    if (!ordersMap[orderId]) {
      ordersMap[orderId] = {
        orderId: orderId,
        products: [],
        totalSalePrice: 0,
        totalCostPrice: 0,
        totalMargin: 0,
        managerId: upsell.managerId,
        managerName: upsell.managerName,
        managerKey: upsell.managerKey,
        date: upsell.date
      };
    }
    
    // Використовуємо готову маржу, якщо вона є (з урахуванням знижок), інакше рахуємо
    const productMargin = upsell.margin !== undefined 
      ? upsell.margin 
      : (productSalePrice - productCostPrice);
    
    ordersMap[orderId].products.push({
      name: upsell.name,
      salePrice: productSalePrice,
      costPrice: productCostPrice,
      quantity: quantity,
      margin: productMargin,
      isSpecialTag: upsell.isSpecialTag || false,
      specialTagName: upsell.specialTagName || null
    });
    
    ordersMap[orderId].totalSalePrice += productSalePrice;
    ordersMap[orderId].totalCostPrice += productCostPrice;
    ordersMap[orderId].totalMargin += productMargin;
  });

  Object.values(ordersMap).forEach((orderData) => {
    // Використовуємо загальну маржу, яка вже враховує знижки
    const margin = orderData.totalMargin;
    // Розраховуємо бонуси для всіх 3 рівнів
    const bonuses = calculateBonusForAllLevels(margin);

    // Перевіряємо, чи це замовлення з одним із спецтегів
    const specialProduct = orderData.products.find(p => p.isSpecialTag === true);
    const specialTagName = specialProduct ? specialProduct.specialTagName : null;
    const isSpecialTag = Boolean(specialTagName);

    const productNames = orderData.products.map(p => p.name).join(', ');
    const productsCount = orderData.products.length;
    let upsellName;
    let typeLabel;

    if (isSpecialTag) {
      upsellName = specialTagName || 'Замовлення за тегом';
      typeLabel = 'За тегом';
    } else if (productsCount > 1) {
      upsellName = `${productsCount} допродажів: ${productNames}`;
      typeLabel = 'Допродаж';
    } else {
      upsellName = productNames;
      typeLabel = 'Допродаж';
    }

    // Визначаємо місяць і рік з дати замовлення
    const { month, year } = getMonthYearFromDateString(orderData.date);
    const managerKey = orderData.managerId || orderData.managerKey || orderData.managerName || 'Без менеджера';

    results.push({
      date: formatDate(orderData.date),
      managerName: orderData.managerName,
      managerId: orderData.managerId,
      managerKey: managerKey,
      upsellName: upsellName,
      salePrice: orderData.totalSalePrice,
      costPrice: orderData.totalCostPrice,
      margin: margin,
      bonusLevel1: bonuses.bonusLevel1,
      bonusLevel2: bonuses.bonusLevel2,
      bonusLevel3: bonuses.bonusLevel3,
      orderId: orderData.orderId,
      upsellId: orderData.orderId,
      quantity: productsCount,
      typeLabel: typeLabel,
      month: month,
      year: year
    });

    // Групуємо по менеджерах і місяцях
    const monthYearKey = `${month}.${year}`;
    const totalsKey = `${managerKey}_${monthYearKey}`;

    if (!managerTotals[totalsKey]) {
      managerTotals[totalsKey] = {
        managerName: orderData.managerName,
        managerId: orderData.managerId,
        managerKey: managerKey,
        month: month,
        year: year,
        totalMargin: 0,
        totalBonusLevel1: 0,
        totalBonusLevel2: 0,
        totalBonusLevel3: 0,
        count: 0
      };
    }

    managerTotals[totalsKey].totalMargin += margin;
    managerTotals[totalsKey].totalBonusLevel1 += bonuses.bonusLevel1;
    managerTotals[totalsKey].totalBonusLevel2 += bonuses.bonusLevel2;
    managerTotals[totalsKey].totalBonusLevel3 += bonuses.bonusLevel3;
    managerTotals[totalsKey].count += productsCount;
  });

  Object.values(managerTotals).forEach(total => {
    results.push({
      date: 'ПІДСУМОК',
      managerName: total.managerName,
      managerId: total.managerId,
      upsellName: `Всього: ${total.count} допродажів`,
      salePrice: '',
      costPrice: '',
      margin: total.totalMargin,
      bonusLevel1: total.totalBonusLevel1,
      bonusLevel2: total.totalBonusLevel2,
      bonusLevel3: total.totalBonusLevel3,
      orderId: '',
      upsellId: '',
      typeLabel: 'Підсумок',
      month: total.month,
      year: total.year
    });
  });
  
  return results;
}

// ========== РОБОТА З GOOGLE ТАБЛИЦЕЮ ==========
/**
 * Отримує або створює лист для запису даних
 * @returns {Sheet} Об'єкт листа
 */
function getOrCreateSheet() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(SHEET_NAME);
  
  if (!sheet) {
    sheet = spreadsheet.insertSheet(SHEET_NAME);
    setupSheetHeaders(sheet);
  } else {
    const firstRow = sheet.getRange(1, 1, 1, 11).getValues()[0];
    const hasHeaders = firstRow[0] === 'Дата' && firstRow[1] === 'Менеджер';
    
    if (!hasHeaders) {
      setupSheetHeaders(sheet);
    }
  }
  
  return sheet;
}

/**
 * Універсальна функція налаштування заголовків таблиці
 * @param {Sheet} sheet - Лист таблиці
 * @param {Array} headers - Масив назв заголовків
 * @param {Array} columnWidths - Масив ширин стовпців
 */
function setupSheetHeadersGeneric(sheet, headers, columnWidths) {
  const headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#4285f4');
  headerRange.setFontColor('#ffffff');

  columnWidths.forEach((width, index) => {
    sheet.setColumnWidth(index + 1, width);
  });

  sheet.setFrozenRows(1);
}

/**
 * Налаштовує заголовки таблиці "Допродажі"
 * @param {Sheet} sheet - Лист таблиці
 */
function setupSheetHeaders(sheet) {
  const headers = [
    'Дата', 'Менеджер', 'ID Менеджера', 'Тип', 'Назва допродажі',
    'Ціна продажу (грн)', 'Собівартість (грн)', 'Маржа (грн)',
    'Бонус менеджера (грн)', 'ID Замовлення', 'ID Допродажі'
  ];
  const widths = [120, 150, 100, 140, 220, 130, 130, 120, 150, 120, 120];
  setupSheetHeadersGeneric(sheet, headers, widths);
}

/**
 * Записує результати в таблицю
 * @param {Sheet} sheet - Лист таблиці
 * @param {Array} results - Масив результатів
 */
function writeResultsToSheet(sheet, results) {
  if (results.length === 0) {
    const firstRow = sheet.getRange(1, 1, 1, 11).getValues()[0];
    if (firstRow[0] !== 'Дата' || firstRow[1] !== 'Менеджер') {
      setupSheetHeaders(sheet);
    }
    return;
  }
  
  const firstRow = sheet.getRange(1, 1, 1, 11).getValues()[0];
  if (firstRow[0] !== 'Дата' || firstRow[1] !== 'Менеджер') {
    setupSheetHeaders(sheet);
  }
  
  const data = results.map(result => [
    result.date,
    result.managerName,
    result.managerId || '',
    result.typeLabel,
    result.upsellName,
    result.salePrice || '',
    result.costPrice || '',
    result.margin,
    result.bonus,
    result.orderId || '',
    result.upsellId || ''
  ]);
  
  if (data.length > 0) {
    // Очищаємо старі дані (всі рядки після заголовка)
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      // Очищаємо вміст замість видалення рядків, щоб уникнути помилки
      // Очищаємо максимум 1000 рядків для безпеки
      const rowsToClear = Math.min(lastRow - 1, 1000);
      if (rowsToClear > 0) {
        const clearRange = sheet.getRange(2, 1, rowsToClear, 11);
        clearRange.clearContent();
        clearRange.clearFormat();
      }
    }
    
    // Записуємо нові дані
    const range = sheet.getRange(2, 1, data.length, data[0].length);
    range.setValues(data);
    
    const lastDataRow = data.length + 1;
    
    sheet.getRange(2, 6, data.length, 1).setNumberFormat('#,##0.00" грн"');
    sheet.getRange(2, 7, data.length, 1).setNumberFormat('#,##0.00" грн"');
    sheet.getRange(2, 8, data.length, 1).setNumberFormat('#,##0.00" грн"');
    sheet.getRange(2, 9, data.length, 1).setNumberFormat('#,##0.00" грн"');
    
    results.forEach((result, index) => {
      if (result.date === 'ПІДСУМОК') {
        const row = index + 2;
        sheet.getRange(row, 1, 1, 11).setBackground('#e8f0fe');
        sheet.getRange(row, 1, 1, 11).setFontWeight('bold');
      }
    });
    
    // Рахуємо суму програмно, беручи тільки значення з підсумків (щоб уникнути подвійного підрахунку)
    let totalMargin = 0;
    let totalBonus = 0;
    results.forEach(result => {
      if (result.date === 'ПІДСУМОК') {
        totalMargin += result.margin || 0;
        totalBonus += result.bonus || 0;
      }
    });
    
    const totalRow = lastDataRow + 1;
    sheet.getRange(totalRow, 1).setValue('ЗАГАЛЬНИЙ ПІДСУМОК');
    sheet.getRange(totalRow, 8).setValue(totalMargin);
    sheet.getRange(totalRow, 9).setValue(totalBonus);
    sheet.getRange(totalRow, 1, 1, 11).setBackground('#1a73e8');
    sheet.getRange(totalRow, 1, 1, 11).setFontColor('#ffffff');
    sheet.getRange(totalRow, 1, 1, 11).setFontWeight('bold');
    sheet.getRange(totalRow, 8, 1, 2).setNumberFormat('#,##0.00" грн"');
  }
}

// ========== ОБРОБКА ЗАМОВЛЕНЬ ДЛЯ ПРЕМІЙ ==========
/**
 * Обробляє ВСІ замовлення (допродажі + з тегами + вхідні) та записує їх в таблиці "Розрахунок МП MM.YY"
 * @param {Array} allOrders - Масив всіх замовлень (допродажі та з тегами)
 * @param {Array} incomingOrders - Масив вхідних замовлень (для ставки 1.5%)
 */
function processAndWriteAllOrdersToPremiya(allOrders, incomingOrders) {
  try {
    // Розділяємо на допродажі та замовлення з тегами
    const regularUpsales = allOrders.filter(u => !u.isSpecialTag);
    const taggedOrders = allOrders.filter(u => u.isSpecialTag);
    
    // Обробляємо допродажі (групуємо по замовленнях)
    const upsalesResults = processUpsales(regularUpsales);
    
    // Обробляємо замовлення з тегами (групуємо товари по замовленнях)
    const taggedResults = [];
    if (taggedOrders.length > 0) {
      // Групуємо товари по замовленнях
      const ordersMap = {};
      taggedOrders.forEach(item => {
        const orderId = item.orderId;
        if (!ordersMap[orderId]) {
          ordersMap[orderId] = {
            orderId: orderId,
            managerId: item.managerId,
            managerName: item.managerName,
            managerKey: item.managerKey,
            date: item.date,
            specialTagName: item.specialTagName,
            products: []
          };
        }
        ordersMap[orderId].products.push(item);
      });
      
      // Групуємо по місяцях
      const ordersByMonth = {};
      Object.values(ordersMap).forEach(order => {
        const { month, year } = getMonthYearFromDateString(order.date);
        if (!month || !year) return;
        const monthYearKey = `${month}.${year}`;
        if (!ordersByMonth[monthYearKey]) {
          ordersByMonth[monthYearKey] = [];
        }
        ordersByMonth[monthYearKey].push(order);
      });
      
      Object.values(ordersByMonth).forEach(monthData => {
        const processed = processTaggedOrdersForMonth(monthData);
        taggedResults.push(...processed);
      });
    }
    
    // Обробляємо вхідні замовлення (для ставки 1.5%)
    const incomingResults = [];
    if (incomingOrders && incomingOrders.length > 0) {
      const incomingByMonth = {};
      incomingOrders.forEach(order => {
        const { month, year } = getMonthYearFromDateString(order.date);
        if (!month || !year) return;
        const monthYearKey = `${month}.${year}`;
        if (!incomingByMonth[monthYearKey]) {
          incomingByMonth[monthYearKey] = [];
        }
        incomingByMonth[monthYearKey].push(order);
      });
      
      Object.values(incomingByMonth).forEach(monthData => {
        const processed = processIncomingOrdersForMonth(monthData);
        incomingResults.push(...processed);
      });
    }
    
    // Об'єднуємо всі результати
    const allResults = [...upsalesResults, ...taggedResults, ...incomingResults];
    
    // Групуємо по місяцях для запису
    const resultsByMonth = {};
    allResults.forEach(result => {
      const month = result.month;
      const year = result.year;
      if (!month || !year) return;
      
      const monthYearKey = `${month}.${year}`;
      if (!resultsByMonth[monthYearKey]) {
        resultsByMonth[monthYearKey] = {
          month: month,
          year: year,
          results: []
        };
      }
      resultsByMonth[monthYearKey].results.push(result);
    });
    
  // Записуємо в таблиці для кожного місяця
    Object.values(resultsByMonth).forEach(monthData => {
      const { month, year, results } = monthData;
    const sheetName = `Розрахунок МП ${month}.${year}`;
      
    Logger.log(`📝 Обробка місяця ${month}.${year}: ${results.length} замовлень (допродажі + з тегами)`);
      
      const sheet = getOrCreatePremiyaSheet(sheetName);
      writeTaggedOrdersToSheet(sheet, results, month, year);
      
      Logger.log(`✅ Записано ${results.length} рядків в "${sheetName}"`);
    });
    
    // Повертаємо всі результати для запису на листи "Виконання"
    return allResults;
    
  } catch (error) {
    Logger.log('❌ Помилка обробки замовлень для премій: ' + error.toString());
    throw error;
  }
}

/**
 * Отримує або створює лист для розрахунку МП
 * @param {string} sheetName - Назва листа
 * @returns {Sheet} Об'єкт листа
 */
function getOrCreatePremiyaSheet(sheetName) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(sheetName);
  
  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
    setupPremiyaSheetHeaders(sheet);
    Logger.log(`✅ Створено новий лист "${sheetName}"`);
  } else {
    const firstRow = sheet.getRange(1, 1, 1, 10).getValues()[0];
    const hasHeaders = firstRow[0] === 'Дата' && firstRow[1] === 'Менеджер';
    
    if (!hasHeaders) {
      setupPremiyaSheetHeaders(sheet);
    }
  }
  
  return sheet;
}

/**
 * Налаштовує заголовки таблиці для премій
 * @param {Sheet} sheet - Лист таблиці
 */
function setupPremiyaSheetHeaders(sheet) {
  const headers = [
    'Дата', 'Менеджер', 'ID Менеджера', 'Тип', 'Назва замовлення',
    'Ціна продажу (грн)', 'Собівартість (грн)', 'Маржа (грн)',
    'ЗП Р1 (3%/50%)', 'ЗП Р2 (4%/55%)', 'ЗП Р3 (5%/60%)', 'ID Замовлення'
  ];
  const widths = [120, 150, 100, 140, 220, 130, 130, 120, 120, 120, 120, 120];
  setupSheetHeadersGeneric(sheet, headers, widths);
}

/**
 * Обробляє замовлення з тегами для конкретного місяця
 * @param {Array} orders - Масив замовлень з тегами
 * @returns {Array} Масив оброблених результатів
 */
function processTaggedOrdersForMonth(orders) {
  const results = [];
  const managerTotals = {};
  
  orders.forEach(order => {
    // Підсумовуємо маржі всіх товарів в замовленні
    let totalSalePrice = 0;
    let totalCostPrice = 0;
    let totalMargin = 0;
    
    order.products.forEach(product => {
      const salePrice = product.salePrice || 0;
      const costPrice = product.costPrice || 0;
      const margin = product.margin !== undefined 
        ? product.margin 
        : (salePrice - costPrice);
      
      totalSalePrice += salePrice;
      totalCostPrice += costPrice;
      totalMargin += margin;
    });
    
    // Розраховуємо бонуси для всіх 3 рівнів
    const bonuses = calculateBonusForAllLevels(totalMargin);

    const { month, year } = getMonthYearFromDateString(order.date);
    const managerKey = order.managerId || order.managerKey || order.managerName || 'Без менеджера';

    // Записуємо замовлення як один рядок
    results.push({
      date: formatDate(order.date),
      managerName: order.managerName,
      managerId: order.managerId,
      managerKey: managerKey,
      typeLabel: 'За тегом',
      orderName: order.specialTagName || 'Замовлення за тегом',
      salePrice: totalSalePrice,
      costPrice: totalCostPrice,
      margin: totalMargin,
      bonusLevel1: bonuses.bonusLevel1,
      bonusLevel2: bonuses.bonusLevel2,
      bonusLevel3: bonuses.bonusLevel3,
      orderId: order.orderId,
      month: month,
      year: year
    });

    // Групуємо по менеджерах
    const monthYearKey = `${month}.${year}`;
    const totalsKey = `${managerKey}_${monthYearKey}`;

    if (!managerTotals[totalsKey]) {
      managerTotals[totalsKey] = {
        managerName: order.managerName,
        managerId: order.managerId,
        managerKey: managerKey,
        month: month,
        year: year,
        totalMargin: 0,
        totalBonusLevel1: 0,
        totalBonusLevel2: 0,
        totalBonusLevel3: 0,
        count: 0
      };
    }

    managerTotals[totalsKey].totalMargin += totalMargin;
    managerTotals[totalsKey].totalBonusLevel1 += bonuses.bonusLevel1;
    managerTotals[totalsKey].totalBonusLevel2 += bonuses.bonusLevel2;
    managerTotals[totalsKey].totalBonusLevel3 += bonuses.bonusLevel3;
    managerTotals[totalsKey].count += 1;
  });

  // Додаємо підсумки
  Object.values(managerTotals).forEach(total => {
    results.push({
      date: 'ПІДСУМОК',
      managerName: total.managerName,
      managerId: total.managerId,
      managerKey: total.managerKey,
      typeLabel: 'Підсумок',
      orderName: `Всього: ${total.count} замовлень за тегами`,
      salePrice: '',
      costPrice: '',
      margin: total.totalMargin,
      bonusLevel1: total.totalBonusLevel1,
      bonusLevel2: total.totalBonusLevel2,
      bonusLevel3: total.totalBonusLevel3,
      orderId: '',
      month: total.month,
      year: total.year
    });
  });
  
  return results;
}

/**
 * Обробляє вхідні замовлення для конкретного місяця (для ставки 3% від маржі)
 * Групує товари по замовленнях перед записом
 * @param {Array} orders - Масив вхідних замовлень (товарів)
 * @returns {Array} Масив оброблених результатів
 */
function processIncomingOrdersForMonth(orders) {
  const results = [];
  const managerTotals = {};

  // Групуємо товари по замовленнях
  const ordersMap = {};
  orders.forEach(item => {
    const orderId = item.orderId;
    const quantity = parseFloat(item.quantity || 1);
    const salePrice = parseFloat(item.salePrice || 0);
    const purchasedPrice = parseFloat(item.purchasedPrice || 0);
    const totalAmount = salePrice * quantity;
    const totalCost = purchasedPrice * quantity;
    // Використовуємо вже пораховану маржу, або рахуємо
    const productMargin = item.productMargin !== undefined
      ? item.productMargin
      : (salePrice - purchasedPrice) * quantity;

    if (!ordersMap[orderId]) {
      ordersMap[orderId] = {
        orderId: orderId,
        managerId: item.managerId,
        managerName: item.managerName,
        managerKey: item.managerKey,
        date: item.date,
        totalAmount: 0,
        totalCost: 0,
        totalMargin: 0,
        productNames: []
      };
    }

    ordersMap[orderId].totalAmount += totalAmount;
    ordersMap[orderId].totalCost += totalCost;
    ordersMap[orderId].totalMargin += productMargin;
    if (item.name && !ordersMap[orderId].productNames.includes(item.name)) {
      ordersMap[orderId].productNames.push(item.name);
    }
  });

  // Створюємо один рядок на замовлення
  Object.values(ordersMap).forEach(order => {
    // Розраховуємо ставки для всіх 3 рівнів
    const rates = calculateRateForAllLevels(order.totalMargin);

    const { month, year } = getMonthYearFromDateString(order.date);
    const managerKey = order.managerId || order.managerKey || order.managerName || 'Без менеджера';

    // Формуємо назву замовлення з назв товарів
    const orderName = order.productNames.length > 0
      ? (order.productNames.length === 1
          ? order.productNames[0]
          : `${order.productNames.length} товарів: ${order.productNames.slice(0, 3).join(', ')}${order.productNames.length > 3 ? '...' : ''}`)
      : 'Вхідне замовлення';

    results.push({
      date: formatDate(order.date),
      managerName: order.managerName,
      managerId: order.managerId,
      managerKey: managerKey,
      typeLabel: 'Вхідне замовлення',
      orderName: orderName,
      salePrice: order.totalAmount,
      costPrice: order.totalCost,
      margin: order.totalMargin,
      rateLevel1: rates.rateLevel1,
      rateLevel2: rates.rateLevel2,
      rateLevel3: rates.rateLevel3,
      orderId: order.orderId,
      month: month,
      year: year
    });

    // Групуємо по менеджерах
    const monthYearKey = `${month}.${year}`;
    const totalsKey = `${managerKey}_${monthYearKey}`;

    if (!managerTotals[totalsKey]) {
      managerTotals[totalsKey] = {
        managerName: order.managerName,
        managerId: order.managerId,
        managerKey: managerKey,
        month: month,
        year: year,
        totalIncoming: 0,
        totalCost: 0,
        totalMargin: 0,
        totalRateLevel1: 0,
        totalRateLevel2: 0,
        totalRateLevel3: 0,
        count: 0
      };
    }

    managerTotals[totalsKey].totalIncoming += order.totalAmount;
    managerTotals[totalsKey].totalCost += order.totalCost;
    managerTotals[totalsKey].totalMargin += order.totalMargin;
    managerTotals[totalsKey].totalRateLevel1 += rates.rateLevel1;
    managerTotals[totalsKey].totalRateLevel2 += rates.rateLevel2;
    managerTotals[totalsKey].totalRateLevel3 += rates.rateLevel3;
    managerTotals[totalsKey].count += 1;
  });

  // Додаємо підсумки
  Object.values(managerTotals).forEach(total => {
    results.push({
      date: 'ПІДСУМОК',
      managerName: total.managerName,
      managerId: total.managerId,
      managerKey: total.managerKey,
      typeLabel: 'Підсумок',
      orderName: `Всього: ${total.count} вхідних замовлень`,
      salePrice: total.totalIncoming,
      costPrice: total.totalCost,
      margin: total.totalMargin,
      rateLevel1: total.totalRateLevel1,
      rateLevel2: total.totalRateLevel2,
      rateLevel3: total.totalRateLevel3,
      orderId: '',
      month: total.month,
      year: total.year
    });
  });

  return results;
}

/**
 * Записує замовлення з тегами в таблицю
 * @param {Sheet} sheet - Лист таблиці
 * @param {Array} results - Масив результатів
 * @param {number} month - Місяць
 * @param {number} year - Рік
 */
function writeTaggedOrdersToSheet(sheet, results, month, year) {
  if (results.length === 0) {
    return;
  }

  const firstRow = sheet.getRange(1, 1, 1, 12).getValues()[0];
  if (firstRow[0] !== 'Дата' || firstRow[1] !== 'Менеджер') {
    setupPremiyaSheetHeaders(sheet);
  }

  // Для кожного результату визначаємо ЗП для 3 рівнів
  // Для допродажів/тегів - це bonusLevel, для вхідних - rateLevel
  const data = results.map(result => {
    const zpLevel1 = result.bonusLevel1 !== undefined ? result.bonusLevel1 : (result.rateLevel1 || 0);
    const zpLevel2 = result.bonusLevel2 !== undefined ? result.bonusLevel2 : (result.rateLevel2 || 0);
    const zpLevel3 = result.bonusLevel3 !== undefined ? result.bonusLevel3 : (result.rateLevel3 || 0);

    return [
      result.date,
      result.managerName,
      result.managerId || '',
      result.typeLabel || 'Допродаж',
      result.orderName || result.upsellName || 'Замовлення',
      result.salePrice || '',
      result.costPrice || '',
      result.margin,
      zpLevel1,
      zpLevel2,
      zpLevel3,
      result.orderId || ''
    ];
  });

  // Очищаємо старі дані (12 стовпців)
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    const rowsToClear = Math.min(lastRow - 1, 1000);
    if (rowsToClear > 0) {
      const clearRange = sheet.getRange(2, 1, rowsToClear, 12);
      clearRange.clearContent();
      clearRange.clearFormat();
    }
  }

  // Записуємо нові дані
  if (data.length > 0) {
    const range = sheet.getRange(2, 1, data.length, data[0].length);
    range.setValues(data);

    const lastDataRow = data.length + 1;

    // Форматуємо числові стовпці (6-11: Ціна, Собівартість, Маржа, ЗП Р1, ЗП Р2, ЗП Р3)
    sheet.getRange(2, 6, data.length, 1).setNumberFormat('#,##0.00" грн"');
    sheet.getRange(2, 7, data.length, 1).setNumberFormat('#,##0.00" грн"');
    sheet.getRange(2, 8, data.length, 1).setNumberFormat('#,##0.00" грн"');
    sheet.getRange(2, 9, data.length, 1).setNumberFormat('#,##0.00" грн"');
    sheet.getRange(2, 10, data.length, 1).setNumberFormat('#,##0.00" грн"');
    sheet.getRange(2, 11, data.length, 1).setNumberFormat('#,##0.00" грн"');

    // Форматуємо підсумкові рядки
    results.forEach((result, index) => {
      if (result.date === 'ПІДСУМОК') {
        const row = index + 2;
        sheet.getRange(row, 1, 1, 12).setBackground('#e8f0fe');
        sheet.getRange(row, 1, 1, 12).setFontWeight('bold');
      }
    });

    // Додаємо загальний підсумок
    let totalMargin = 0;
    let totalZpLevel1 = 0;
    let totalZpLevel2 = 0;
    let totalZpLevel3 = 0;
    results.forEach(result => {
      if (result.date === 'ПІДСУМОК') {
        totalMargin += result.margin || 0;
        totalZpLevel1 += (result.bonusLevel1 !== undefined ? result.bonusLevel1 : result.rateLevel1) || 0;
        totalZpLevel2 += (result.bonusLevel2 !== undefined ? result.bonusLevel2 : result.rateLevel2) || 0;
        totalZpLevel3 += (result.bonusLevel3 !== undefined ? result.bonusLevel3 : result.rateLevel3) || 0;
      }
    });

    const totalRow = lastDataRow + 1;
    sheet.getRange(totalRow, 1).setValue('ЗАГАЛЬНИЙ ПІДСУМОК');
    sheet.getRange(totalRow, 8).setValue(totalMargin);
    sheet.getRange(totalRow, 9).setValue(totalZpLevel1);
    sheet.getRange(totalRow, 10).setValue(totalZpLevel2);
    sheet.getRange(totalRow, 11).setValue(totalZpLevel3);
    sheet.getRange(totalRow, 1, 1, 12).setBackground('#1a73e8');
    sheet.getRange(totalRow, 1, 1, 12).setFontColor('#ffffff');
    sheet.getRange(totalRow, 1, 1, 12).setFontWeight('bold');
    sheet.getRange(totalRow, 8, 1, 4).setNumberFormat('#,##0.00" грн"');
  }
}

// ========== ДОПОМІЖНІ ФУНКЦІЇ ==========

/**
 * Округлює число до 2 знаків після коми
 * @param {number} value - Число для округлення
 * @returns {number} Округлене число
 */
function round2(value) {
  return Math.round((value || 0) * 100) / 100;
}

/**
 * Розраховує бонус для всіх трьох рівнів менеджерів
 * Бонус = відсоток від маржі, якщо маржа > порогу
 * @param {number} margin - Маржа замовлення/допродажу
 * @returns {Object} Об'єкт з бонусами для кожного рівня
 */
function calculateBonusForAllLevels(margin) {
  const result = {};
  for (let level = 1; level <= 3; level++) {
    const config = MANAGER_LEVELS[level];
    result[`bonusLevel${level}`] = margin > config.threshold
      ? round2(margin * (config.bonus / 100))
      : 0;
  }
  return result;
}

/**
 * Розраховує ставку для всіх трьох рівнів менеджерів
 * Ставка = відсоток від маржі вхідних замовлень (без порогу)
 * @param {number} margin - Маржа вхідного замовлення
 * @returns {Object} Об'єкт зі ставками для кожного рівня
 */
function calculateRateForAllLevels(margin) {
  const result = {};
  for (let level = 1; level <= 3; level++) {
    const config = MANAGER_LEVELS[level];
    result[`rateLevel${level}`] = round2(margin * (config.rate / 100));
  }
  return result;
}

/**
 * Отримує ціну продажу товару з різних можливих полів
 * @param {Object} product - Об'єкт товару
 * @returns {number} Ціна продажу
 */
function getProductPriceSold(product) {
  const offer = product.offer || {};
  return parseFloat(
    product.price_sold ||
    product.price ||
    product.sale_price ||
    offer.price ||
    offer.sale_price ||
    0
  );
}

/**
 * Отримує закупівельну ціну товару з різних можливих полів
 * @param {Object} product - Об'єкт товару
 * @returns {number} Закупівельна ціна
 */
function getProductPurchasedPrice(product) {
  const offer = product.offer || {};
  return parseFloat(
    product.purchased_price ||
    offer.purchased_price ||
    product.cost ||
    product.cost_price ||
    offer.cost ||
    offer.cost_price ||
    0
  );
}

/**
 * Отримує назву товару з різних можливих полів
 * @param {Object} product - Об'єкт товару
 * @param {string} defaultName - Назва за замовчуванням
 * @returns {string} Назва товару
 */
function getProductName(product, defaultName = 'Товар') {
  const offer = product.offer || {};
  return product.name || product.product_name || offer.name || defaultName;
}

/**
 * Очищає область та записує дані в таблицю
 * @param {Sheet} sheet - Лист таблиці
 * @param {number} startRow - Початковий рядок
 * @param {number} startCol - Початковий стовпець
 * @param {Array} data - Двовимірний масив даних
 * @param {number} clearRows - Кількість рядків для очищення (за замовчуванням 100)
 */
function clearAndWriteData(sheet, startRow, startCol, data, clearRows = 100) {
  const colCount = data.length > 0 ? data[0].length : 1;

  // Очищаємо
  const clearRange = sheet.getRange(startRow, startCol, clearRows, colCount);
  clearRange.clearContent();
  clearRange.clearFormat();

  // Записуємо
  if (data.length > 0) {
    const range = sheet.getRange(startRow, startCol, data.length, colCount);
    range.setValues(data);
  }
}

/**
 * Форматує стовпці як валюту (грн)
 * @param {Sheet} sheet - Лист таблиці
 * @param {number} startRow - Початковий рядок
 * @param {Array} columns - Масив номерів стовпців для форматування
 * @param {number} rowCount - Кількість рядків
 */
function formatCurrencyColumns(sheet, startRow, columns, rowCount) {
  columns.forEach(col => {
    sheet.getRange(startRow, col, rowCount, 1).setNumberFormat('#,##0.00" грн"');
  });
}

function isProductUpsell(product) {
  if (product.upsale === true) {
    return true;
  }
  
  if (product.upsell === true || product.is_upsell === true) {
    return true;
  }
  
  const offer = product.offer || {};
  if (offer.upsale === true || offer.upsell === true || offer.is_upsell === true) {
    return true;
  }
  
  return false;
}

function normalizeManagerName(name) {
  const fallback = 'Невідомий менеджер';
  if (name === undefined || name === null) {
    return { displayName: fallback, key: fallback.toLowerCase() };
  }
  
  const collapsed = name.toString().trim().replace(/\s+/g, ' ');
  const displayName = collapsed || fallback;
  const key = displayName.toLowerCase();
  
  return { displayName, key };
}

function normalizeTagValue(value) {
  if (value === undefined || value === null) return '';
  return value.toString().trim().toLowerCase();
}

/**
 * Повертає назву першого тегу замовлення, що збігається з переліком
 * @param {Object} order - Об'єкт замовлення
 * @param {string|Array<string>} tagNames - Назви тегів для пошуку
 * @returns {string|null} Назва знайденого тегу або null
 */
function getOrderTagName(order, tagNames) {
  if (!order || !tagNames) {
    return null;
  }

  const targets = Array.isArray(tagNames) ? tagNames : [tagNames];
  const normalizedTargets = targets.map(normalizeTagValue).filter(Boolean);
  if (normalizedTargets.length === 0) {
    return null;
  }
  
  // Отримуємо теги з різних можливих полів
  const tagsRaw = order.tags;
  if (!tagsRaw) {
    return null;
  }
  
  // Переконуємося, що tags - це масив
  const tagsArray = Array.isArray(tagsRaw) ? tagsRaw : [tagsRaw];
  if (tagsArray.length === 0) {
    return null;
  }
  
  // Проходимо по всіх тегах
  for (let tag of tagsArray) {
    if (!tag) continue;
    
    // Якщо тег - це рядок, перевіряємо його напряму
    if (typeof tag === 'string') {
      const normalized = normalizeTagValue(tag);
      if (normalized && normalizedTargets.includes(normalized)) {
        // Знаходимо відповідний target за індексом
        const targetIndex = normalizedTargets.indexOf(normalized);
        return targets[targetIndex] || tag;
      }
    } 
    // Якщо тег - це об'єкт (структура KEYCRM: {id, name, alias, color, ...})
    else if (tag && typeof tag === 'object') {
      // Перевіряємо name (основна назва тегу)
      if (tag.name) {
        const normalizedName = normalizeTagValue(tag.name);
        if (normalizedName && normalizedTargets.includes(normalizedName)) {
          // Повертаємо оригінальну назву з targets (щоб зберегти точну назву)
          const targetIndex = normalizedTargets.indexOf(normalizedName);
          return targets[targetIndex] || tag.name;
        }
      }
      
      // Перевіряємо alias (системна назва, може бути латиницею)
      // Якщо в targets є кирилична назва "Відгук", а alias = "vidguk", 
      // то збігу не буде, але це нормально - ми шукаємо по name
      if (tag.alias) {
        const normalizedAlias = normalizeTagValue(tag.alias);
        if (normalizedAlias && normalizedTargets.includes(normalizedAlias)) {
          const targetIndex = normalizedTargets.indexOf(normalizedAlias);
          return targets[targetIndex] || tag.name || tag.alias;
        }
      }
    }
  }
  
  return null;
}

/**
 * Перевіряє, чи замовлення має вказаний тег або один з переліку
 * @param {Object} order - Об'єкт замовлення
 * @param {string|Array<string>} tagName - Назва(и) тегу для пошуку
 * @returns {boolean} true, якщо замовлення має тег
 */
function hasOrderTag(order, tagName) {
  return Boolean(getOrderTagName(order, tagName));
}

/**
 * Отримує діапазон дат для фільтрації замовлень
 * @param {string} period - Період: 'last_month', 'this_month', 'this_month_to_yesterday', 'last_30_days', 'custom', 'all'
 * @returns {Object} Об'єкт з полями start та end (або null для 'all')
 */
function getDateRange(period) {
  const now = new Date();
  const timezone = Session.getScriptTimeZone();
  let startDate, endDate;

  const formatDateForAPI = (date, useUTC = CONVERT_DATES_TO_UTC_FOR_API) => {
    if (useUTC) {
      const year = date.getUTCFullYear();
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const day = String(date.getUTCDate()).padStart(2, '0');
      const hours = String(date.getUTCHours()).padStart(2, '0');
      const minutes = String(date.getUTCMinutes()).padStart(2, '0');
      const seconds = String(date.getUTCSeconds()).padStart(2, '0');
      return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    } else {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      const seconds = String(date.getSeconds()).padStart(2, '0');
      return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    }
  };
  
  switch (period) {
    case 'last_month':
      startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      endDate = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
      break;
      
    case 'this_month':
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      endDate = new Date(now);
      break;
      
    case 'this_month_to_yesterday':
      // Початок: перше число поточного місяця, 00:00:00
      startDate = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
      // Кінець: вчора, 23:59:59
      endDate = new Date(now);
      endDate.setDate(endDate.getDate() - 1); // Вчора
      endDate.setHours(23, 59, 59, 999);
      break;
      
    case 'last_30_days':
      startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 30);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(now);
      break;
      
    case 'custom':
      try {
        const timezone = DATES_TIMEZONE || Session.getScriptTimeZone();
        const startParts = CUSTOM_START_DATE.split(/[- :]/);
        const endParts = CUSTOM_END_DATE.split(/[- :]/);

        const startYear = parseInt(startParts[0]);
        const startMonth = parseInt(startParts[1]) - 1;
        const startDay = parseInt(startParts[2]);
        const startHour = parseInt(startParts[3]);
        const startMinute = parseInt(startParts[4]);
        const startSecond = parseInt(startParts[5]);

        const endYear = parseInt(endParts[0]);
        const endMonth = parseInt(endParts[1]) - 1;
        const endDay = parseInt(endParts[2]);
        const endHour = parseInt(endParts[3]);
        const endMinute = parseInt(endParts[4]);
        const endSecond = parseInt(endParts[5]);

        // Визначаємо offset для Ukraine (Europe/Kiev)
        // Літній час (березень-жовтень): UTC+3
        // Зимовий час (листопад-лютий): UTC+2
        const getUkraineOffset = (year, month, day) => {
          if (month >= 2 && month <= 9) {
            return 3; // UTC+3 (літній час)
          }
          return 2; // UTC+2 (зимовий час)
        };

        const startOffset = getUkraineOffset(startYear, startMonth, startDay);
        const endOffset = getUkraineOffset(endYear, endMonth, endDay);

        // Створюємо дати як локальний час у часовому поясі Europe/Kiev
        // Використовуємо Date.UTC для створення UTC timestamp з локальних параметрів
        // Потім віднімаємо offset, щоб отримати правильний UTC час для API
        // Наприклад: якщо користувач вводить "2025-11-30 00:00:00" (Kyiv, UTC+2),
        // то в UTC це буде "2025-10-29 22:00:00"
        // Але для фільтра нам потрібно включити весь день 2025-11-30 в Києві,
        // тому додаємо offset до початку і кінця діапазону
        const startLocalUTC = Date.UTC(startYear, startMonth, startDay, startHour, startMinute, startSecond);
        const endLocalUTC = Date.UTC(endYear, endMonth, endDay, endHour, endMinute, endSecond);

        // Віднімаємо offset, щоб конвертувати з локального часу Ukraine в UTC
        startDate = new Date(startLocalUTC - (startOffset * 60 * 60 * 1000));
        endDate = new Date(endLocalUTC - (endOffset * 60 * 60 * 1000));
      } catch (e) {
        Logger.log('Помилка парсингу кастомних дат: ' + e.toString());
        startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        endDate = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
      }
      break;
      
    case 'all':
      return null;
      
    default:
      startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      endDate = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
  }

  return {
    start: formatDateForAPI(startDate),
    end: formatDateForAPI(endDate)
  };
}

/**
 * Форматує дату для відображення
 * @param {string} dateString - Дата в форматі ISO
 * @returns {string} Відформатована дата
 */
function formatDate(dateString) {
  if (!dateString) return '';
  
  try {
    const date = new Date(dateString);
    return Utilities.formatDate(date, Session.getScriptTimeZone(), 'dd.MM.yyyy HH:mm');
  } catch (e) {
    return dateString;
  }
}

function createHeaders() {
  try {
    const sheet = getOrCreateSheet();
    setupSheetHeaders(sheet);
    Logger.log('✅ Заголовки успішно створені/оновлені');
    return true;
  } catch (error) {
    Logger.log('❌ Помилка створення заголовків: ' + error.toString());
    throw error;
  }
}

// ========== ЗАПИС БОНУСІВ НА ЛИСТИ "ВИКОНАННЯ" ==========
/**
 * Записує бонуси менеджерів на листи "Виконання MM.YYYY" з результатів премій
 * @param {Array} allResults - Масив всіх результатів з таблиць "Премії МП MM.YY"
 * @param {Object} dateRange - Об'єкт з полями start та end для визначення місяця і року
 */
function writeManagerBonusesToPerformanceSheetsFromPremiya(allResults, dateRange) {
  try {
    if (!allResults || allResults.length === 0) {
      Logger.log('Немає результатів для запису бонусів');
      return;
    }
    
    // Отримуємо бонуси менеджерів з результатів (рядки з "ПІДСУМОК")
    const managerBonuses = [];
    
    allResults.forEach(result => {
      if (result.date === 'ПІДСУМОК' && result.bonus > 0) {
        managerBonuses.push({
          managerName: result.managerName,
          managerId: result.managerId,
          bonus: result.bonus,
          margin: result.margin,
          percentage: BONUS_PERCENTAGE * 100,
          month: result.month,
          year: result.year
        });
      }
    });
    
    if (managerBonuses.length === 0) {
      Logger.log('Бонуси менеджерів не знайдено');
      return;
    }
    
    // Групуємо бонуси по місяцях
    const bonusesByMonth = {};
    
    managerBonuses.forEach(bonus => {
      if (bonus.month && bonus.year) {
        const monthYearKey = `${bonus.month}.${bonus.year}`;
        
        if (!bonusesByMonth[monthYearKey]) {
          bonusesByMonth[monthYearKey] = {
            month: bonus.month,
            year: bonus.year,
            bonuses: []
          };
        }
        
        bonusesByMonth[monthYearKey].bonuses.push(bonus);
      }
    });
    
    // Записуємо бонуси на відповідні листи для кожного місяця
    Object.values(bonusesByMonth).forEach(monthData => {
      const { month, year, bonuses } = monthData;
      // Об’єднуємо бонуси одного менеджера (допродажі + теги)
      const aggregatedBonuses = aggregateBonusesByManager(bonuses);
      
      Logger.log(`Обробка місяця: ${month}.${year}, бонусів: ${aggregatedBonuses.length} (агреговано)`);
      
      // Знаходимо лист "Виконання MM.YYYY" для відповідного місяця і року
      const performanceSheet = findPerformanceSheetByMonthYear(month, year);
      
      if (!performanceSheet) {
        Logger.log(`Лист "Виконання ${month}.${year}" не знайдено`);
        return;
      }
      
      // Знаходимо клітинку "ЗП менеджерів з продажу" і записуємо бонуси
      let headerCell = findUpsalesBonusHeader(performanceSheet);
      
      // Якщо заголовок не знайдено, створюємо його
      if (!headerCell) {
        Logger.log(`⚠️ Клітинку "ЗП менеджерів з продажу" не знайдено, створюємо заголовки...`);
        headerCell = createPremiyaHeadersOnPerformanceSheet(performanceSheet);
      } else {
        // Якщо заголовок знайдено, оновлюємо його та створюємо підзаголовки, якщо потрібно
        headerCell = updatePremiyaHeadersIfNeeded(performanceSheet, headerCell);
      }
      
      if (headerCell) {
        writeBonusesToSheet(performanceSheet, headerCell, aggregatedBonuses);
        Logger.log(`✅ Бонуси записано на лист "${performanceSheet.getName()}" (${aggregatedBonuses.length} менеджерів)`);
      } else {
        Logger.log(`❌ Не вдалося створити заголовки на листі "${performanceSheet.getName()}"`);
      }
    });
    
  } catch (error) {
    Logger.log('❌ Помилка запису бонусів на листи "Виконання": ' + error.toString());
    throw error;
  }
}

/**
 * Записує ставку 1.5% від вхідних замовлень (без тегів та допродажів)
 * на листи "Виконання MM.YYYY"
 * @param {Array} incomingOrders - Масив вхідних замовлень
 */
function writeManagerBaseRatesToPerformanceSheets(incomingOrders) {
  try {
    if (!incomingOrders || incomingOrders.length === 0) {
      Logger.log('Немає вхідних замовлень для розрахунку ставки');
      return;
    }
    
    const aggregatedRates = aggregateIncomingOrdersForRates(incomingOrders);
    
    if (!aggregatedRates || aggregatedRates.length === 0) {
      Logger.log('Ставка менеджерів: немає даних після агрегації');
      return;
    }
    
    const ratesByMonth = {};
    
    aggregatedRates.forEach(rate => {
      if (rate.month && rate.year) {
        const key = `${rate.month}.${rate.year}`;
        if (!ratesByMonth[key]) {
          ratesByMonth[key] = {
            month: rate.month,
            year: rate.year,
            rates: []
          };
        }
        ratesByMonth[key].rates.push(rate);
      }
    });
    
    Object.values(ratesByMonth).forEach(monthData => {
      const { month, year, rates } = monthData;
      const performanceSheet = findPerformanceSheetByMonthYear(month, year);
      
      if (!performanceSheet) {
        Logger.log(`Лист "Виконання ${month}.${year}" не знайдено для ставки`);
        return;
      }
      
      let headerCell = findManagerRateHeader(performanceSheet);
      
      if (!headerCell) {
        Logger.log(`⚠️ Клітинку ставки менеджерів не знайдено, створюємо заголовки...`);
        headerCell = createManagerRateHeadersOnPerformanceSheet(performanceSheet);
      }
      
      if (headerCell) {
        writeManagerRatesToSheet(performanceSheet, headerCell, rates);
        Logger.log(`✅ Ставку 1.5% записано на лист "${performanceSheet.getName()}" (${rates.length} менеджерів)`);
      } else {
        Logger.log(`❌ Не вдалося створити заголовки ставки на листі "${performanceSheet.getName()}"`);
      }
    });
    
  } catch (error) {
    Logger.log('❌ Помилка запису ставки менеджерів: ' + error.toString());
    throw error;
  }
}

/**
 * Єдина точка запису підсумків (ставка + бонус) на листи "Виконання MM.YYYY"
 * Формує одну таблицю з колонками:
 * ПІБ | Ставка | Бонуси | Загалом
 * Всі дані беруться з таблиці "Розрахунок МП" (allResults), без подвійного розрахунку
 * @param {Array} allResults - Результати з листів "Розрахунок МП" (вже містить всі розрахунки)
 */
function writeManagerSummaryToPerformanceSheets(allResults) {
  try {
    // Витягуємо бонуси з результатів (допродажі та замовлення за тегами)
    const bonusesRaw = getManagerBonusesFromResults(allResults || []);
    
    // Логування для діагностики
    Logger.log(`📊 Знайдено ${bonusesRaw.length} підсумків бонусів:`);
    bonusesRaw.forEach(b => {
      Logger.log(`  - ${b.managerName}: ${b.bonus} грн (місяць ${b.month}.${b.year})`);
    });
    
    const bonusesByMonth = {};
    const aggregatedBonuses = aggregateBonusesByManager(bonusesRaw);
    
    // Логування після агрегації
    Logger.log(`📊 Після агрегації: ${aggregatedBonuses.length} менеджерів:`);
    aggregatedBonuses.forEach(b => {
      Logger.log(`  - ${b.managerName}: ${b.bonus} грн (місяць ${b.month}.${b.year})`);
    });
    
    aggregatedBonuses.forEach(bonus => {
      if (!bonus.month || !bonus.year) return;
      const key = `${bonus.month}.${bonus.year}`;
      if (!bonusesByMonth[key]) {
        bonusesByMonth[key] = [];
      }
      bonusesByMonth[key].push(bonus);
    });
    
    // Витягуємо ставки з результатів (вхідні замовлення) - без перерахунку!
    const ratesRaw = getManagerRatesFromResults(allResults || []);
    
    // Логування для діагностики
    Logger.log(`📊 Знайдено ${ratesRaw.length} підсумків ставок:`);
    ratesRaw.forEach(r => {
      Logger.log(`  - ${r.managerName}: ${r.rateAmount} грн (місяць ${r.month}.${r.year})`);
    });
    
    const ratesByMonth = {};
    const aggregatedRates = aggregateRatesByManager(ratesRaw);
    
    // Логування після агрегації
    Logger.log(`📊 Після агрегації ставок: ${aggregatedRates.length} менеджерів:`);
    aggregatedRates.forEach(r => {
      Logger.log(`  - ${r.managerName}: ${r.rateAmount} грн (місяць ${r.month}.${r.year})`);
    });
    
    aggregatedRates.forEach(rate => {
      if (!rate.month || !rate.year) return;
      const key = `${rate.month}.${rate.year}`;
      if (!ratesByMonth[key]) {
        ratesByMonth[key] = [];
      }
      ratesByMonth[key].push(rate);
    });
    
    // Обходимо всі місяці, що зустрічаються в бонусах або ставках
    const monthKeys = new Set([...Object.keys(bonusesByMonth), ...Object.keys(ratesByMonth)]);
    if (monthKeys.size === 0) {
      Logger.log('Немає даних для запису підсумкової таблиці по менеджерах');
      return;
    }
    
    monthKeys.forEach(key => {
      const [monthStr, yearStr] = key.split('.');
      const month = parseInt(monthStr, 10);
      const year = parseInt(yearStr, 10);
      const performanceSheet = findPerformanceSheetByMonthYear(month, year);
      if (!performanceSheet) {
        Logger.log(`Лист "Виконання ${key}" не знайдено для підсумків`);
        return;
      }
      
      const summaryRows = combineRatesAndBonuses(
        ratesByMonth[key] || [],
        bonusesByMonth[key] || []
      );
      
      let headerCell = findUpsalesBonusHeader(performanceSheet);
      if (!headerCell) {
        Logger.log(`⚠️ Заголовок підсумкової таблиці не знайдено, створюємо...`);
        headerCell = createPremiyaHeadersOnPerformanceSheet(performanceSheet);
      } else {
        headerCell = updatePremiyaHeadersIfNeeded(performanceSheet, headerCell);
      }
      
      if (headerCell) {
        writeManagerSummaryRows(performanceSheet, headerCell, summaryRows);
        Logger.log(`✅ Підсумкова таблиця записана на лист "${performanceSheet.getName()}" (${summaryRows.length} менеджерів)`);
      } else {
        Logger.log(`❌ Не вдалося створити заголовки підсумкової таблиці на "${performanceSheet.getName()}"`);
      }
    });
    
  } catch (error) {
    Logger.log('❌ Помилка запису підсумкової таблиці менеджерів: ' + error.toString());
    throw error;
  }
}

/**
 * Отримує бонуси менеджерів з результатів (рядки з "ПІДСУМОК")
 * Зберігає інформацію про місяць і рік для групування
 * @param {Array} results - Масив результатів
 * @returns {Array} Масив об'єктів з бонусами менеджерів
 */
function getManagerBonusesFromResults(results) {
  const bonuses = [];

  results.forEach(result => {
    // Беремо ТІЛЬКИ рядки з "ПІДСУМОК" та типом "Підсумок"
    // Ігноруємо вхідні замовлення - вони мають rateLevel замість bonusLevel
    const isIncomingOrder = (
      result.orderName &&
      typeof result.orderName === 'string' &&
      result.orderName.toLowerCase().includes('вхідних замовлень')
    ) || (
      result.rateLevel1 !== undefined // Вхідні мають rateLevel, а не bonusLevel
    );

    // Перевіряємо, чи є бонуси хоча б на одному рівні
    const hasBonuses = (result.bonusLevel1 > 0 || result.bonusLevel2 > 0 || result.bonusLevel3 > 0);

    if (result.date === 'ПІДСУМОК' &&
        result.typeLabel === 'Підсумок' &&
        !isIncomingOrder &&
        hasBonuses) {
      bonuses.push({
        managerName: result.managerName,
        managerId: result.managerId,
        bonusLevel1: result.bonusLevel1 || 0,
        bonusLevel2: result.bonusLevel2 || 0,
        bonusLevel3: result.bonusLevel3 || 0,
        margin: result.margin,
        month: result.month,
        year: result.year
      });
    }
  });

  return bonuses;
}

/**
 * Агрегує бонуси по менеджеру, щоб допродажі і замовлення з тегами
 * записувалися одним рядком на лист "Виконання"
 * @param {Array} bonuses - Масив бонусів за місяць
 * @returns {Array} Масив агрегованих бонусів по кожному менеджеру
 */
function aggregateBonusesByManager(bonuses) {
  const aggregated = {};

  bonuses.forEach(bonus => {
    const managerName = bonus.managerName || 'Невідомий менеджер';
    const { key: normalizedKey } = normalizeManagerName(managerName);
    const managerKey = bonus.managerId || normalizedKey || managerName;

    if (!aggregated[managerKey]) {
      aggregated[managerKey] = {
        managerName: managerName,
        managerId: bonus.managerId,
        bonusLevel1: 0,
        bonusLevel2: 0,
        bonusLevel3: 0,
        margin: 0,
        month: bonus.month,
        year: bonus.year
      };
    }

    aggregated[managerKey].bonusLevel1 = round2(aggregated[managerKey].bonusLevel1 + (bonus.bonusLevel1 || 0));
    aggregated[managerKey].bonusLevel2 = round2(aggregated[managerKey].bonusLevel2 + (bonus.bonusLevel2 || 0));
    aggregated[managerKey].bonusLevel3 = round2(aggregated[managerKey].bonusLevel3 + (bonus.bonusLevel3 || 0));
    aggregated[managerKey].margin = round2(aggregated[managerKey].margin + (bonus.margin || 0));
  });

  return Object.values(aggregated);
}

/**
 * Отримує ставки менеджерів з результатів (рядки з "ПІДСУМОК" для вхідних замовлень)
 * Зберігає інформацію про місяць і рік для групування
 * @param {Array} results - Масив результатів
 * @returns {Array} Масив об'єктів зі ставками менеджерів
 */
function getManagerRatesFromResults(results) {
  const rates = [];

  results.forEach(result => {
    // Беремо ТІЛЬКИ рядки з "ПІДСУМОК" для вхідних замовлень
    // Вони мають rateLevel1/2/3 замість bonusLevel1/2/3
    const isIncomingOrder = result.rateLevel1 !== undefined;

    // Перевіряємо, чи є ставки хоча б на одному рівні
    const hasRates = (result.rateLevel1 > 0 || result.rateLevel2 > 0 || result.rateLevel3 > 0);

    if (result.date === 'ПІДСУМОК' &&
        result.typeLabel === 'Підсумок' &&
        isIncomingOrder &&
        hasRates) {
      rates.push({
        managerName: result.managerName,
        managerId: result.managerId,
        totalIncoming: result.salePrice || 0,
        rateLevel1: result.rateLevel1 || 0,
        rateLevel2: result.rateLevel2 || 0,
        rateLevel3: result.rateLevel3 || 0,
        month: result.month,
        year: result.year
      });
    }
  });

  return rates;
}

/**
 * Агрегує ставки по менеджеру
 * @param {Array} rates - Масив ставок за місяць
 * @returns {Array} Масив агрегованих ставок по кожному менеджеру
 */
function aggregateRatesByManager(rates) {
  const aggregated = {};

  rates.forEach(rate => {
    const managerName = rate.managerName || 'Невідомий менеджер';
    const { key: normalizedKey } = normalizeManagerName(managerName);
    const managerKey = rate.managerId || normalizedKey || managerName;

    if (!aggregated[managerKey]) {
      aggregated[managerKey] = {
        managerName: managerName,
        managerId: rate.managerId,
        totalIncoming: 0,
        rateLevel1: 0,
        rateLevel2: 0,
        rateLevel3: 0,
        month: rate.month,
        year: rate.year
      };
    }

    aggregated[managerKey].totalIncoming = round2(aggregated[managerKey].totalIncoming + (rate.totalIncoming || 0));
    aggregated[managerKey].rateLevel1 = round2(aggregated[managerKey].rateLevel1 + (rate.rateLevel1 || 0));
    aggregated[managerKey].rateLevel2 = round2(aggregated[managerKey].rateLevel2 + (rate.rateLevel2 || 0));
    aggregated[managerKey].rateLevel3 = round2(aggregated[managerKey].rateLevel3 + (rate.rateLevel3 || 0));
  });

  return Object.values(aggregated);
}

/**
 * Агрегує вхідні замовлення по менеджеру та місяцю для розрахунку ставки 3% від маржі
 * @param {Array} incomingOrders - Масив вхідних замовлень (без тегів/допродажів)
 * @returns {Array} Масив агрегованих записів з totalMargin та rateAmount
 */
function aggregateIncomingOrdersForRates(incomingOrders) {
  if (!incomingOrders || incomingOrders.length === 0) {
    return [];
  }

  // Групуємо по orderId для розрахунку маржі по замовленню
  const ordersMap = {};
  incomingOrders.forEach(item => {
    const orderId = item.orderId;
    const quantity = parseFloat(item.quantity || 1);
    const salePrice = parseFloat(item.salePrice || 0);
    const purchasedPrice = parseFloat(item.purchasedPrice || 0);
    // Використовуємо вже пораховану маржу, або рахуємо
    const productMargin = item.productMargin !== undefined
      ? item.productMargin
      : (salePrice - purchasedPrice) * quantity;

    if (!ordersMap[orderId]) {
      ordersMap[orderId] = {
        orderId: orderId,
        managerId: item.managerId,
        managerName: item.managerName,
        managerKey: item.managerKey,
        date: item.date,
        totalMargin: 0
      };
    }
    ordersMap[orderId].totalMargin += productMargin;
  });

  // Розраховуємо ставки для всіх 3 рівнів
  const ordersWithRates = Object.values(ordersMap).map(order => {
    const rates = calculateRateForAllLevels(order.totalMargin);

    return {
      orderId: order.orderId,
      managerId: order.managerId,
      managerName: order.managerName,
      managerKey: order.managerKey,
      date: order.date,
      totalMargin: order.totalMargin,
      rateLevel1: rates.rateLevel1,
      rateLevel2: rates.rateLevel2,
      rateLevel3: rates.rateLevel3
    };
  });

  // Тепер групуємо по менеджеру та місяцю для підсумку
  const aggregated = {};

  ordersWithRates.forEach(order => {
    const { month, year } = getMonthYearFromDateString(order.date);
    if (!month || !year) {
      return;
    }

    const managerName = order.managerName || 'Невідомий менеджер';
    const { key: normalizedKey } = normalizeManagerName(managerName);
    const managerKey = order.managerId || normalizedKey || managerName;

    const aggKey = `${managerKey}_${month}.${year}`;

    if (!aggregated[aggKey]) {
      aggregated[aggKey] = {
        managerName: managerName,
        managerId: order.managerId,
        managerKey: managerKey,
        month: month,
        year: year,
        totalIncoming: 0,
        totalRateLevel1: 0,
        totalRateLevel2: 0,
        totalRateLevel3: 0
      };
    }

    // Підсумовуємо маржу як totalIncoming для відображення
    aggregated[aggKey].totalIncoming = round2(aggregated[aggKey].totalIncoming + order.totalMargin);
    aggregated[aggKey].totalRateLevel1 = round2(aggregated[aggKey].totalRateLevel1 + order.rateLevel1);
    aggregated[aggKey].totalRateLevel2 = round2(aggregated[aggKey].totalRateLevel2 + order.rateLevel2);
    aggregated[aggKey].totalRateLevel3 = round2(aggregated[aggKey].totalRateLevel3 + order.rateLevel3);
  });

  return Object.values(aggregated).map(item => {
    return {
      managerName: item.managerName,
      managerId: item.managerId,
      managerKey: item.managerKey,
      month: item.month,
      year: item.year,
      totalIncoming: item.totalIncoming,
      rateLevel1: item.totalRateLevel1,
      rateLevel2: item.totalRateLevel2,
      rateLevel3: item.totalRateLevel3
    };
  });
}

/**
 * Визначає місяць і рік з дати (ISO string або інший формат)
 * @param {string} dateString - Дата в різних форматах
 * @returns {Object} Об'єкт з полями month та year
 */
function getMonthYearFromDateString(dateString) {
  if (!dateString) {
    return { month: null, year: null };
  }
  
  try {
    let date;
    
    // Спробуємо парсити ISO формат
    if (typeof dateString === 'string' && dateString.includes('T')) {
      date = new Date(dateString);
    } else if (typeof dateString === 'string' && dateString.includes('.')) {
      // Формат "dd.MM.yyyy HH:mm"
      const parts = dateString.split(' ');
      const datePart = parts[0]; // "dd.MM.yyyy"
      const dateParts = datePart.split('.');
      
      if (dateParts.length === 3) {
        const day = parseInt(dateParts[0]);
        const month = parseInt(dateParts[1]);
        const year = parseInt(dateParts[2]);
        
        return { month: month, year: year };
      }
    } else {
      date = new Date(dateString);
    }
    
    if (date && !isNaN(date.getTime())) {
      const month = date.getMonth() + 1; // getMonth() повертає 0-11
      const year = date.getFullYear();
      
      return { month: month, year: year };
    }
  } catch (e) {
    Logger.log('Помилка парсингу дати: ' + e.toString());
  }
  
  return { month: null, year: null };
}

/**
 * Знаходить лист "Виконання MM.YYYY" для конкретного місяця і року
 * @param {number} month - Місяць (1-12)
 * @param {number} year - Рік (наприклад, 2025)
 * @returns {Sheet|null} Лист або null, якщо не знайдено
 */
function findPerformanceSheetByMonthYear(month, year) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const allSheets = spreadsheet.getSheets();
  
  // Формуємо назву листа: "Виконання MM.YYYY" (наприклад, "Виконання 12.2025")
  const expectedName = `Виконання ${month}.${year}`;
  
  // Також перевіряємо варіанти з пробілами та різними форматами
  const possibleNames = [
    expectedName,
    `Виконання ${String(month).padStart(2, '0')}.${year}`,
    `Виконання ${month}.${String(year).slice(-2)}`, // YY замість YYYY
    `Виконання ${String(month).padStart(2, '0')}.${String(year).slice(-2)}`
  ];
  
  for (let sheet of allSheets) {
    const sheetName = sheet.getName().trim();
    if (possibleNames.includes(sheetName)) {
      return sheet;
    }
  }
  
  // Якщо точна назва не знайдена, шукаємо за регулярним виразом
  const pattern = new RegExp(`^Виконання\\s+${month}\\.${year}$`, 'i');
  for (let sheet of allSheets) {
    const sheetName = sheet.getName();
    if (pattern.test(sheetName)) {
      return sheet;
    }
  }
  
  return null;
}

/**
 * Оновлює заголовок та створює підзаголовки, якщо їх немає
 * @param {Sheet} sheet - Лист для оновлення
 * @param {Range} headerCell - Клітинка з основним заголовком
 * @returns {Range} Оновлена клітинка з основним заголовком
 */
function updatePremiyaHeadersIfNeeded(sheet, headerCell) {
  const headerRow = headerCell.getRow();
  const headerCol = headerCell.getColumn();
  const currentHeaderValue = sheet.getRange(headerRow, headerCol).getValue();
  const subHeaderRow = headerRow + 1;

  // Перевіряємо підзаголовки (очікується 10 колонок для 3 рівнів)
  const subHeaderValues = sheet.getRange(subHeaderRow, headerCol, 1, 10).getValues()[0];
  const h1 = subHeaderValues[0];

  // Перевіряємо, чи є нові заголовки з рівнями (Р1, Р2, Р3)
  const hasNewHeaders = subHeaderValues.some(h => h && h.toString().includes('Р1'));

  // Оновлюємо основний заголовок, якщо він старий
  const normalizedHeader = currentHeaderValue ? currentHeaderValue.toString().toLowerCase() : '';
  if (!normalizedHeader.includes('зп менеджерів з продажу') &&
      (normalizedHeader.includes('допродаж') || normalizedHeader.includes('бонус'))) {
    Logger.log(`⚠️ Знайдено старий заголовок "${currentHeaderValue}", оновлюємо на "ЗП менеджерів з продажу"...`);
    sheet.getRange(headerRow, headerCol).setValue('ЗП менеджерів з продажу');
    sheet.getRange(headerRow, headerCol).setFontWeight('bold');
    sheet.getRange(headerRow, headerCol).setFontSize(11);
  }

  // Якщо підзаголовків немає або вони старі (без рівнів), створюємо нові
  if (!h1 || !hasNewHeaders) {
    Logger.log(`⚠️ Підзаголовки не знайдено або застарілі, створюємо нові для 3 рівнів...`);

    const newSubHeaders = [
      'ПІБ',
      'Ставка Р1', 'Бонуси Р1', 'Разом Р1',
      'Ставка Р2', 'Бонуси Р2', 'Разом Р2',
      'Ставка Р3', 'Бонуси Р3', 'Разом Р3'
    ];
    sheet.getRange(subHeaderRow, headerCol, 1, newSubHeaders.length).setValues([newSubHeaders]);
    sheet.getRange(subHeaderRow, headerCol, 1, newSubHeaders.length).setFontWeight('bold');
    sheet.getRange(subHeaderRow, headerCol, 1, newSubHeaders.length).setBackground('#e8f0fe');
  }

  return headerCell;
}

/**
 * Створює заголовки таблиці "ЗП менеджерів з продажу" на листі "Виконання"
 * Шукає вільне місце в стовпці F або створює в кінці листа
 * @param {Sheet} sheet - Лист для створення заголовків
 * @returns {Range|null} Клітинка з основним заголовком або null
 */
function createPremiyaHeadersOnPerformanceSheet(sheet) {
  try {
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();

    // Шукаємо вільне місце в стовпці F (стовпець 6)
    let targetRow = 1;
    let targetCol = 6; // Стовпець F

    // Якщо лист не порожній, шукаємо вільне місце після останніх даних
    if (lastRow > 0) {
      // Перевіряємо, чи є вільне місце в стовпці F після останнього рядка
      const columnF = sheet.getRange(1, 6, lastRow, 1);
      const values = columnF.getValues();

      // Шукаємо перший порожній рядок в стовпці F
      let foundEmpty = false;
      for (let i = 0; i < values.length; i++) {
        if (!values[i][0] || values[i][0].toString().trim() === '') {
          targetRow = i + 1;
          foundEmpty = true;
          break;
        }
      }

      // Якщо не знайдено порожнього місця, додаємо після останнього рядка
      if (!foundEmpty) {
        targetRow = lastRow + 2; // Додаємо один порожній рядок для відступу
      }
    }

    // Створюємо заголовки
    const headerRow = targetRow;
    const subHeaderRow = targetRow + 1;

    // Основний заголовок
    sheet.getRange(headerRow, targetCol).setValue('ЗП менеджерів з продажу');
    sheet.getRange(headerRow, targetCol).setFontWeight('bold');
    sheet.getRange(headerRow, targetCol).setFontSize(11);

    // Підзаголовки - розгорнутий формат для 3 рівнів
    const subHeaders = [
      'ПІБ',
      'Ставка Р1', 'Бонуси Р1', 'Разом Р1',
      'Ставка Р2', 'Бонуси Р2', 'Разом Р2',
      'Ставка Р3', 'Бонуси Р3', 'Разом Р3'
    ];
    sheet.getRange(subHeaderRow, targetCol, 1, subHeaders.length).setValues([subHeaders]);

    // Форматуємо підзаголовки
    sheet.getRange(subHeaderRow, targetCol, 1, subHeaders.length).setFontWeight('bold');
    sheet.getRange(subHeaderRow, targetCol, 1, subHeaders.length).setBackground('#e8f0fe');

    // Налаштовуємо ширину стовпців
    sheet.setColumnWidth(targetCol, 180); // ПІБ
    for (let i = 1; i <= 9; i++) {
      sheet.setColumnWidth(targetCol + i, 100); // Колонки даних
    }
    
    Logger.log(`✅ Створено заголовки таблиці "ЗП менеджерів з продажу" на рядку ${headerRow}, стовпець ${targetCol}`);
    
    // Повертаємо клітинку з основним заголовком
    return sheet.getRange(headerRow, targetCol);
    
  } catch (error) {
    Logger.log(`❌ Помилка створення заголовків: ${error.toString()}`);
    return null;
  }
}

/**
 * Універсальна функція пошуку заголовка на листі за предикатом
 * @param {Sheet} sheet - Лист для пошуку
 * @param {Function} matchFn - Функція-предикат для перевірки значення клітинки
 * @param {number} priorityColumn - Пріоритетний стовпець для пошуку (опціонально)
 * @param {string} logLabel - Мітка для логування (опціонально)
 * @returns {Range|null} Клітинка або null
 */
function findHeaderByPredicate(sheet, matchFn, priorityColumn, logLabel = 'заголовок') {
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();

  if (lastRow === 0 || lastCol === 0) {
    Logger.log(`Лист "${sheet.getName()}" порожній`);
    return null;
  }

  // Спочатку шукаємо в пріоритетному стовпці
  if (priorityColumn && lastCol >= priorityColumn) {
    const columnData = sheet.getRange(1, priorityColumn, lastRow, 1).getValues();
    for (let i = 0; i < columnData.length; i++) {
      if (matchFn(columnData[i][0])) {
        Logger.log(`Знайдено ${logLabel} в стовпці ${priorityColumn}, рядок ${i + 1}`);
        return sheet.getRange(i + 1, priorityColumn);
      }
    }
  }

  // Шукаємо по всьому листу
  const allData = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  for (let row = 0; row < allData.length; row++) {
    for (let col = 0; col < allData[row].length; col++) {
      if (matchFn(allData[row][col])) {
        Logger.log(`Знайдено ${logLabel} в стовпці ${col + 1}, рядок ${row + 1}`);
        return sheet.getRange(row + 1, col + 1);
      }
    }
  }

  Logger.log(`${logLabel} не знайдено на листі "${sheet.getName()}"`);
  return null;
}

/**
 * Знаходить клітинку "ЗП менеджерів з продажу" на листі
 * @param {Sheet} sheet - Лист для пошуку
 * @returns {Range|null} Клітинка або null
 */
function findUpsalesBonusHeader(sheet) {
  const matchFn = (cellValue) => {
    if (!cellValue || typeof cellValue !== 'string') return false;
    const v = cellValue.toLowerCase().trim();
    return (v.includes('зп') && v.includes('менеджер') && v.includes('продаж')) ||
           v.includes('зп менеджерів з продажу') ||
           ((v.includes('зарплата') || v.includes('зп')) && v.includes('менеджер')) ||
           (v.includes('допродаж') && v.includes('бонус') && v.includes('менеджер'));
  };
  return findHeaderByPredicate(sheet, matchFn, 6, 'ЗП менеджерів з продажу');
}

/**
 * Записує бонуси менеджерів на лист під знайденою клітинкою
 * Записує в три окремі клітинки: ПІБ (F), Відсоток (G), Сума бонуса (H)
 * @param {Sheet} sheet - Лист для запису
 * @param {Range} headerCell - Клітинка з заголовком "ЗП менеджерів з продажу"
 * @param {Array} bonuses - Масив об'єктів з бонусами менеджерів
 */
function writeBonusesToSheet(sheet, headerCell, bonuses) {
  const headerRow = headerCell.getRow();
  const headerCol = headerCell.getColumn(); // Стовпець, де знайдено заголовок (F = 6)
  
  // Перевіряємо, чи є підзаголовки (ПІБ, Відсоток, Сума бонуса)
  // Якщо в наступному рядку є "ПІБ", то дані записуємо після нього
  const subHeaderRow = headerRow + 1;
  const subHeaderValue = sheet.getRange(subHeaderRow, headerCol).getValue();
  const startRow = (subHeaderValue && subHeaderValue.toString().toLowerCase().includes('піб')) 
    ? subHeaderRow + 1  // Якщо є підзаголовки, записуємо після них
    : headerRow + 1;    // Якщо немає, записуємо після основного заголовка
  
  // Очищаємо старий вміст (видаляємо 100 рядків в трьох стовпцях для безпеки)
  const clearRange = sheet.getRange(startRow, headerCol, 100, 3);
  clearRange.clearContent();
  clearRange.clearFormat();
  
  // Записуємо нові дані в три стовпці
  if (bonuses.length > 0) {
    const data = bonuses.map(bonus => {
      // Три окремі клітинки: ПІБ, Відсоток, Сума бонуса
      return [
        bonus.managerName, // Стовпець F (ПІБ)
        `${bonus.percentage}%`, // Стовпець G (Відсоток)
        `${bonus.bonus.toFixed(2)} грн` // Стовпець H (Сума бонуса)
      ];
    });
    
    const range = sheet.getRange(startRow, headerCol, data.length, 3);
    range.setValues(data);
    
    // Форматуємо стовпець з відсотком як текст
    sheet.getRange(startRow, headerCol + 1, data.length, 1).setNumberFormat('@');
    // Форматуємо стовпець з сумою як текст
    sheet.getRange(startRow, headerCol + 2, data.length, 1).setNumberFormat('@');
  }
}

/**
 * Знаходить клітинку заголовка для ставки менеджерів
 * @param {Sheet} sheet - Лист для пошуку
 * @returns {Range|null} Клітинка або null
 */
function findManagerRateHeader(sheet) {
  const matchFn = (cellValue) => {
    if (!cellValue || typeof cellValue !== 'string') return false;
    const v = cellValue.toLowerCase().trim();
    return (v.includes('ставк') && v.includes('менедж')) ||
           (v.includes('вхідн') && v.includes('1.5'));
  };
  return findHeaderByPredicate(sheet, matchFn, 10, 'ставка менеджерів');
}

/**
 * Створює заголовки для ставки менеджерів (вхідні замовлення)
 * @param {Sheet} sheet - Лист для створення заголовків
 * @returns {Range|null} Клітинка з основним заголовком або null
 */
function createManagerRateHeadersOnPerformanceSheet(sheet) {
  try {
    const lastRow = sheet.getLastRow();
    const targetCol = 10; // Стовпець J
    let targetRow = 1;
    
    if (lastRow > 0) {
      const columnJ = sheet.getRange(1, targetCol, lastRow, 1);
      const values = columnJ.getValues();
      
      let foundEmpty = false;
      for (let i = 0; i < values.length; i++) {
        if (!values[i][0] || values[i][0].toString().trim() === '') {
          targetRow = i + 1;
          foundEmpty = true;
          break;
        }
      }
      
      if (!foundEmpty) {
        targetRow = lastRow + 2; // Відступ рядком
      }
    }
    
    const headerRow = targetRow;
    const subHeaderRow = headerRow + 1;
    
    sheet.getRange(headerRow, targetCol).setValue('Ставка менеджерів (1.5% від вхідних замовлень)');
    sheet.getRange(headerRow, targetCol).setFontWeight('bold');
    sheet.getRange(headerRow, targetCol).setFontSize(11);
    
    sheet.getRange(subHeaderRow, targetCol).setValue('ПІБ');
    sheet.getRange(subHeaderRow, targetCol + 1).setValue('Сума вхідних замовлень');
    sheet.getRange(subHeaderRow, targetCol + 2).setValue('Відсоток');
    sheet.getRange(subHeaderRow, targetCol + 3).setValue('Сума ставки');
    
    sheet.getRange(subHeaderRow, targetCol, 1, 4).setFontWeight('bold');
    sheet.getRange(subHeaderRow, targetCol, 1, 4).setBackground('#e8f0fe');
    
    sheet.setColumnWidth(targetCol, 150); // ПІБ
    sheet.setColumnWidth(targetCol + 1, 170); // Сума вхідних
    sheet.setColumnWidth(targetCol + 2, 90); // Відсоток
    sheet.setColumnWidth(targetCol + 3, 130); // Сума ставки
    
    Logger.log(`✅ Створено заголовки ставки менеджерів на рядку ${headerRow}, стовпець ${targetCol}`);
    return sheet.getRange(headerRow, targetCol);
    
  } catch (error) {
    Logger.log(`❌ Помилка створення заголовків ставки менеджерів: ${error.toString()}`);
    return null;
  }
}

/**
 * Записує ставку менеджерів під заголовком ставки
 * @param {Sheet} sheet - Лист для запису
 * @param {Range} headerCell - Клітинка з заголовком ставки
 * @param {Array} rates - Масив агрегованих ставок менеджерів
 */
function writeManagerRatesToSheet(sheet, headerCell, rates) {
  const headerRow = headerCell.getRow();
  const headerCol = headerCell.getColumn(); // Очікуваний стовпець J
  
  const subHeaderRow = headerRow + 1;
  const subHeaderValue = sheet.getRange(subHeaderRow, headerCol).getValue();
  const startRow = (subHeaderValue && subHeaderValue.toString().toLowerCase().includes('піб'))
    ? subHeaderRow + 1
    : headerRow + 1;
  
  // Очищаємо старі дані (4 стовпці, 100 рядків для безпеки)
  const clearRange = sheet.getRange(startRow, headerCol, 100, 4);
  clearRange.clearContent();
  clearRange.clearFormat();
  
  if (rates.length > 0) {
    const data = rates.map(rate => [
      rate.managerName,
      rate.totalIncoming || 0,
      `${rate.ratePercent}%`,
      rate.rateAmount || 0
    ]);
    
    const range = sheet.getRange(startRow, headerCol, data.length, 4);
    range.setValues(data);
    
    sheet.getRange(startRow, headerCol + 1, data.length, 1).setNumberFormat('#,##0.00" грн"');
    sheet.getRange(startRow, headerCol + 3, data.length, 1).setNumberFormat('#,##0.00" грн"');
    sheet.getRange(startRow, headerCol + 2, data.length, 1).setNumberFormat('@');
  }
}

/**
 * Об'єднує ставки та бонуси по менеджеру для одного місяця
 * @param {Array} rates - Агреговані ставки (вхідні замовлення)
 * @param {Array} bonuses - Агреговані бонуси (допродажі/теги)
 * @returns {Array} Масив з підсумком по менеджеру
 */
function combineRatesAndBonuses(rates, bonuses) {
  const map = {};

  const addIfMissing = (key, name, id) => {
    if (!map[key]) {
      map[key] = {
        managerName: name || 'Невідомий менеджер',
        managerId: id || null,
        // Ставки для 3 рівнів
        rateLevel1: 0,
        rateLevel2: 0,
        rateLevel3: 0,
        // Бонуси для 3 рівнів
        bonusLevel1: 0,
        bonusLevel2: 0,
        bonusLevel3: 0
      };
    }
  };

  rates.forEach(rate => {
    const { key: normalizedKey } = normalizeManagerName(rate.managerName || '');
    const mapKey = rate.managerId || normalizedKey || rate.managerName || 'unknown';
    addIfMissing(mapKey, rate.managerName, rate.managerId);
    map[mapKey].rateLevel1 = round2(map[mapKey].rateLevel1 + (rate.rateLevel1 || 0));
    map[mapKey].rateLevel2 = round2(map[mapKey].rateLevel2 + (rate.rateLevel2 || 0));
    map[mapKey].rateLevel3 = round2(map[mapKey].rateLevel3 + (rate.rateLevel3 || 0));
  });

  bonuses.forEach(bonus => {
    const { key: normalizedKey } = normalizeManagerName(bonus.managerName || '');
    const mapKey = bonus.managerId || normalizedKey || bonus.managerName || 'unknown';
    addIfMissing(mapKey, bonus.managerName, bonus.managerId);
    map[mapKey].bonusLevel1 = round2(map[mapKey].bonusLevel1 + (bonus.bonusLevel1 || 0));
    map[mapKey].bonusLevel2 = round2(map[mapKey].bonusLevel2 + (bonus.bonusLevel2 || 0));
    map[mapKey].bonusLevel3 = round2(map[mapKey].bonusLevel3 + (bonus.bonusLevel3 || 0));
  });

  return Object.values(map);
}

/**
 * Записує об'єднану таблицю (ставка + бонус) для 3 рівнів під заголовком
 * @param {Sheet} sheet - Лист для запису
 * @param {Range} headerCell - Клітинка з заголовком
 * @param {Array} rows - Дані по менеджерах
 */
function writeManagerSummaryRows(sheet, headerCell, rows) {
  const headerRow = headerCell.getRow();
  const headerCol = headerCell.getColumn();
  const startRow = headerRow + 2; // після підзаголовків

  // Очищаємо старі дані (10 стовпців для 3 рівнів, запас 150 рядків)
  const clearRange = sheet.getRange(startRow, headerCol, 150, 10);
  clearRange.clearContent();
  clearRange.clearFormat();

  if (!rows || rows.length === 0) {
    return;
  }

  // Розгорнутий формат: ПІБ + 9 колонок для 3 рівнів
  // Ставка Р1 | Бонуси Р1 | Разом Р1 | Ставка Р2 | Бонуси Р2 | Разом Р2 | Ставка Р3 | Бонуси Р3 | Разом Р3
  const data = rows.map(item => {
    const rate1 = round2(item.rateLevel1 || 0);
    const bonus1 = round2(item.bonusLevel1 || 0);
    const total1 = round2(rate1 + bonus1);

    const rate2 = round2(item.rateLevel2 || 0);
    const bonus2 = round2(item.bonusLevel2 || 0);
    const total2 = round2(rate2 + bonus2);

    const rate3 = round2(item.rateLevel3 || 0);
    const bonus3 = round2(item.bonusLevel3 || 0);
    const total3 = round2(rate3 + bonus3);

    return [
      item.managerName || 'Невідомий менеджер',
      rate1, bonus1, total1,
      rate2, bonus2, total2,
      rate3, bonus3, total3
    ];
  });

  const range = sheet.getRange(startRow, headerCol, data.length, 10);
  range.setValues(data);

  // Формати для всіх числових стовпців (колонки 2-10)
  for (let col = 1; col <= 9; col++) {
    sheet.getRange(startRow, headerCol + col, data.length, 1).setNumberFormat('#,##0.00" грн"');
  }
}

// ========== ЛОГУВАННЯ ==========
/**
 * Логує детальну інформацію про замовлення в файл
 * @param {Object} order - Об'єкт замовлення з KEYCRM
 * @param {Object} calculations - Об'єкт з розрахунками
 */
function logOrderDetails(order, calculations) {
  try {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    const logFileName = `Логи розрахунків ${Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')}.txt`;
    
    // Шукаємо файл логів в папці таблиці
    let logFile;
    const files = DriveApp.getFilesByName(logFileName);
    if (files.hasNext()) {
      logFile = files.next();
    } else {
      // Створюємо новий файл
      const folder = DriveApp.getFileById(spreadsheet.getId()).getParents().next();
      logFile = folder.createFile(logFileName, '', MimeType.PLAIN_TEXT);
    }
    
    let logContent = logFile.getBlob().getDataAsString();
    const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
    
    logContent += `\n\n========== ЗАМОВЛЕННЯ #${order.id} - ${timestamp} ==========\n`;
    logContent += `Дата: ${order.created_at || 'Невідома'}\n`;
    logContent += `Менеджер: ${order.manager?.full_name || order.manager_name || 'Невідомий'}\n`;
    logContent += `Теги: ${order.tags ? order.tags.map(t => typeof t === 'string' ? t : t.name).join(', ') : 'Немає'}\n`;
    logContent += `Grand Total: ${order.grand_total || 0} грн\n`;
    logContent += `Total Discount: ${order.total_discount || 0} грн\n`;
    
    if (calculations.products && calculations.products.length > 0) {
      logContent += `\n--- ТОВАРИ ---\n`;
      calculations.products.forEach((product, index) => {
        logContent += `\nТовар ${index + 1}: ${product.name}\n`;
        logContent += `  Price Sold: ${product.priceSold} грн\n`;
        logContent += `  Purchased Price: ${product.purchasedPrice} грн\n`;
        logContent += `  Quantity: ${product.quantity}\n`;
        logContent += `  Product Discount: ${product.productDiscount || 0} грн\n`;
        logContent += `  Product Margin: ${product.productMargin || 0} грн\n`;
        logContent += `  Order Discount Part: ${product.orderDiscountPart || 0} грн\n`;
        logContent += `  Final Margin: ${product.finalMargin || 0} грн\n`;
      });
    }
    
    if (calculations.totalMargin !== undefined) {
      logContent += `\n--- ПІДСУМОК ---\n`;
      logContent += `Загальна маржа: ${calculations.totalMargin} грн\n`;
      logContent += `Бонус (50%): ${calculations.bonus || 0} грн\n`;
    }
    
    if (calculations.totalIncoming !== undefined) {
      logContent += `\n--- ПІДСУМОК ВХІДНИХ ---\n`;
      logContent += `Загальна сума: ${calculations.totalIncoming} грн\n`;
      logContent += `Ставка (1.5%): ${calculations.rateAmount || 0} грн\n`;
    }
    
    logFile.setContent(logContent);
    Logger.log(`✅ Лог записано для замовлення #${order.id}`);
  } catch (error) {
    Logger.log(`❌ Помилка логування: ${error.toString()}`);
  }
}