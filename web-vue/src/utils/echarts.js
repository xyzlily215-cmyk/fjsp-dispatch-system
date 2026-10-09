/* ECharts 按需注册：甘特图仅用到 custom/bar 系列 + title/legend/grid/tooltip/graphic 组件，
   替代 `import * as echarts from 'echarts'` 全量引入（主包 gzip 由 ~350KB 降到 ~120KB 量级）。
   新增图表类型时在此补充 use() 注册。 */
import * as echarts from 'echarts/core';
import { BarChart, CustomChart } from 'echarts/charts';
import {
  GraphicComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  BarChart,
  CustomChart,
  GraphicComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export default echarts;
