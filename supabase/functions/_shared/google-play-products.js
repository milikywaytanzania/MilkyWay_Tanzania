export const GOOGLE_PLAY_PACKAGE_NAME = 'com.masiyatunda.milkyway';
export const GOOGLE_PLAY_COIN_PACKAGES = [10, 50, 100, 500, 1000]
  .map(coins => ({ productId: `mw_coins_${coins}`, coins }));
