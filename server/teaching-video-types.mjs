// Each rule describes a required combination of problem signals, a question for
// the opening, and the procedure the explanation should actually demonstrate.
const models = [
  {
    id:'meter-limits',group:'电学计算',type:'电表量程与动态电路',
    match:text=>/电流表|电压表/.test(text)&&/量程|满偏|满片|不[能可]超过|安全电路/.test(text)&&/接入|滑动|R2|最大值|最小值/i.test(text),
    tested:'串联分压、等效电路、电表量程与取值',
    hook:'电压表满偏时，电流表会不会先超量程？',
    method:'先画各个电路状态，用欧姆定律列式，再把电流和电压代回量程检验。',
    finish:/自相矛盾|解出来|符合|不成立|取值|阻值为/
  },
  {
    id:'source-voltage',group:'电学计算',type:'串联电路求电源电压',
    match:text=>/电源.{0,6}(?:电压|的U)|总电压/.test(text)&&/最大|总电阻|串联|R1.{0,32}加上/i.test(text)&&/安|电流/.test(text),
    tested:'串联总电阻、欧姆定律',
    hook:'题目只给电流和两个电阻，电源电压怎么求？',
    method:'找题目指定的滑片位置，先加出串联总电阻，再用该状态的电流乘总电阻。',
    finish:/等于.{0,10}(?:伏|V)|电源.{0,8}是|所以.{0,8}电压/i
  },
  {
    id:'ohm-resistance',group:'电学计算',type:'欧姆定律求电阻',
    match:text=>/R等于U比I|R\s*=\s*U\s*\/\s*I|电压.{0,16}(?:除以|比上).{0,14}电流|伏.{0,14}(?:除以|比上).{0,8}安/i.test(text),
    tested:'同一元件的电压和电流、R = U / I',
    hook:'求 R1 时，题目里的哪一组电压和电流能用？',
    method:'先找 R1 两端的电压和流过它的电流，用 R = U / I，结果写成欧姆。',
    finish:/等于|(?:求|算)出|(?:\d+(?:\.\d+)?)\s*(?:欧|Ω)/i
  },
  {
    id:'liquid-removal',group:'力学计算',type:'取出物块后的液体压强',
    match:text=>/取出|拿出|拿走/.test(text)&&/漂浮|沉底|排开/.test(text)&&/水深|液面/.test(text)&&/压强|R水JH|液体压强/i.test(text),
    tested:'物体浮沉、稳定液面高度、液体压强',
    hook:'分别取出 A 或 B，哪一种情况下容器底压强更大？',
    method:'分两种情况判断剩下物块的浮沉，求稳定水深，再用 p = ρgh 比较压强。',
    finish:/(?:[Pp][₁₂₃123]|压强)[\s\S]{0,68}(?:等于\s*\d+|\d+\s*(?:帕|Pa|%))/i
  },
  {
    id:'surface-pressure',group:'力学计算',type:'容器对桌面的固体压强',
    match:text=>/水平桌面|固体压强|容器.{0,15}桌面/.test(text)&&/受力面积|接触面积|底面积|F\s*(?:\/|比)\s*S|FBS/i.test(text)&&/压力|总重|总BS/.test(text),
    tested:'受压面、总压力、面积单位换算',
    hook:'容器里放了两个物块，桌面承受的是谁的重量？',
    method:'先找桌面承担的总压力，再把接触面积换成平方米，代入 p = F / S。',
    finish:/算出来是|压强(?:是|为|等于).{0,10}\d|\d+\s*(?:Pa|帕)/i
  },
  {
    id:'gravity',group:'力学计算',type:'已知质量求重力',
    match:text=>/重力|大G/.test(text)&&/质量|千克|kg/i.test(text)&&/G[呢，,\s]*(?:=|等于)\s*(?:[Mm]|质量)|重力.{0,18}质量乘/i.test(text),
    tested:'重力与质量的关系、G = mg',
    hook:'题目给了容器质量，怎么求容器自身的重力？',
    method:'取容器自身的质量，代入 G = mg，把结果写成牛顿。',
    finish:/等于\s*\d+(?:\.\d+)?\s*(?:牛|N)|重力(?:是|为).{0,10}牛/i
  },
  {
    id:'electric-power',group:'电学计算',type:'用电器功率计算',
    match:text=>/电功率|实际功率|额定功率/.test(text)&&/电压|电流/.test(text)&&/P\s*(?:=|等于)|求.{0,12}功率/i.test(text),
    tested:'实际电压、电流与电功率',
    hook:'灯泡的实际功率，该用额定电压还是实际电压？',
    method:'先确认用电器的实际工作状态，再用对应的电压和电流计算功率。',
  },
  {
    id:'density',group:'力学计算',type:'由质量和体积求密度',
    match:text=>/求.{0,10}密度|密度.{0,8}(?:多少|多大)|ρ\s*=\s*m\s*\//i.test(text)&&/质量/.test(text)&&/体积/.test(text),
    tested:'密度公式与质量、体积单位',
    hook:'知道质量和体积，密度该怎么算？',
    method:'统一质量和体积单位，再用 ρ = m / V，写清密度单位。',
  },
  {
    id:'buoyancy',group:'力学计算',type:'排液法求浮力',
    match:text=>/浮力/.test(text)&&/排开.{0,10}(?:液体|水).{0,10}体积|V排|阿基米德/i.test(text)&&/算|求|等于/.test(text),
    tested:'阿基米德原理、实际排液体积',
    hook:'物体只浸进一部分，算浮力该用哪个体积？',
    method:'先找实际排开液体的体积，再用 F浮 = ρ液gV排。',
  },
  {
    id:'heat',group:'热学计算',type:'比热容与热量计算',
    match:text=>/比热容/.test(text)&&/温差|升高.{0,8}温度|末温|初温/.test(text)&&/求.{0,10}热量|吸收.{0,7}热量|Q\s*(?:=|等于)/i.test(text),
    tested:'比热容、质量、温度变化量',
    hook:'算吸收的热量，公式里代末温还是温差？',
    method:'先用末温和初温求温度变化量，再代入 Q = cmΔt。',
  },
  {
    id:'diffusion',group:'知识辨析',type:'扩散现象解释',
    match:text=>/扩散/.test(text)&&/分子/.test(text)&&/无规则|运动|彼此进入/.test(text),
    tested:'分子不停地做无规则运动',
    hook:'静置的液体里，颜色为什么会自己散开？',
    method:'把观察到的扩散现象和分子不停地做无规则运动联系起来。',
  },
  {
    id:'drawing',group:'作图与图像',type:'物理作图题',
    match:text=>/(?:画出|作出|补画|作图题).{0,28}(?:示意图|法线|入射光线|反射光线|折射光线|力臂|电路图)/.test(text),
    tested:'研究对象与作图规则',hook:'这张图第一笔应该画在哪里？',
    method:'先定研究对象和已知方向，再按对应规律画线、标注。',
  },
  {
    id:'chart',group:'作图与图像',type:'物理图像与读数',
    match:text=>/图像|图表|坐标/.test(text)&&/横轴|纵轴|斜率|坐标轴/.test(text)&&/读出|判断|求|比较/.test(text),
    tested:'坐标轴、单位与图像关系',hook:'横轴和纵轴不一样，图上的点该怎么读？',
    method:'先看坐标轴和单位，再读相关数据，最后按题目要求比较或计算。',
  },
  {
    id:'experiment',group:'实验探究',type:'控制变量实验',
    match:text=>/实验|探究/.test(text)&&/控制变量|[^。]{0,8}保持.{0,9}不变/.test(text)&&/改变|比较|测量|更换/.test(text),
    tested:'控制量、改变的量与观测量',hook:'这道实验题里，哪个量必须保持不变？',
    method:'先明确探究对象，固定无关条件，只改变要研究的量，再比较观测结果。',
  }
];

export function classifyTeachingQuestion(text){
  return models.find(model=>model.match(text));
}
