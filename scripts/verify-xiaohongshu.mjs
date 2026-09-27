import {
  xhsBadgeCandidateIsValid,
  xhsLightCandidateIsValid,
} from '../src/rules.js'

if (!xhsBadgeCandidateIsValid(0.26812727345329185)) {
  throw new Error('小红书被遮挡徽标样本应通过')
}
if (xhsBadgeCandidateIsValid(0.2499)) {
  throw new Error('小红书徽标低于门槛时不应通过')
}
if (xhsBadgeCandidateIsValid(0.195197)) {
  throw new Error('非小红书样本的最高徽标分数不应通过')
}

const lightAccount = {
  score: 0.38010077957608857,
  factor: 1,
  scale: 1.1291666666666667,
  dx: 1,
  dy: -3,
  whiteStrokeDensity: 0.13471419396274886,
  activeColumnRatio: 0.7803468208092486,
}
if (!xhsLightCandidateIsValid(lightAccount)) {
  throw new Error('小红书浅色账号样本应通过')
}
if (xhsLightCandidateIsValid({
  ...lightAccount,
  score: 0.37961791286197266,
  factor: 0.78,
  dy: -10,
  whiteStrokeDensity: 0.05801435406698564,
  activeColumnRatio: 0.42045454545454547,
})) {
  throw new Error('清言背景的相似亮纹理不应误判为小红书账号')
}
if (xhsLightCandidateIsValid({ ...lightAccount, factor: 1.12 })) {
  throw new Error('非标准缩放比例不应触发小红书浅色账号兜底')
}

console.log('小红书徽标与浅色账号联合门槛校验通过')
