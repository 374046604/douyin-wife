/** 直播等级、勋章和会员图标绝不能作为用户头像保存。 */
const nonAvatarImagePattern = /(?:grade[_-]?level|user[_-]?grade|medal|badge|fans?[_-]?club|fanclub|wealth[_-]?level|membership|member[_-]?icon|vip|subscribe(?:[_-]?new)?)/iu;

export function isNonAvatarImageUrl(value: string | undefined): boolean {
  return Boolean(value && nonAvatarImagePattern.test(value));
}
