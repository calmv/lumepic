type PickerNavigator = Pick<Navigator, 'userAgent'> & {
  userAgentData?: { platform?: string };
};

export function getImagePickerAccept(browser: PickerNavigator = navigator): string | undefined {
  const isAndroid = browser.userAgentData?.platform === 'Android' || /\bAndroid\b/i.test(browser.userAgent);
  // An unrestricted input lets Android Chromium use its file chooser without requiring media access.
  return isAndroid ? undefined : 'image/*';
}
