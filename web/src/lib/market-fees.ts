// Steam 社区市场的手续费算法:逐行移植后端 src/market/fees.ts(它又照抄 Steam 网页 economy_common.js 的
// CalculateAmountToSendForDesiredReceivedAmount / CalculateFeeAmount),两边算出来的价格必须一致。改这里要同步改后端。
//
// 所有金额都是钱包币种的最小单位(分),整数。
//   买家价(buyer price) = 卖家到手(receive) + Steam 手续费 + 发行商手续费
//   Steam 手续费 = floor(max(到手 × 5%, 1) + 0)
//   发行商手续费 = floor(max(到手 × 发行商费率, 1))     (费率 >0 时;CS2 / TF2 等默认 0.10)
// 两项各自至少 1 分,所以买家价最低 3 分(到手 1 分)。

export interface FeeConfig {
	/** wallet_fee_percent,默认 0.05 */
	steamFeePercent: number;
	/** wallet_fee_minimum(分),默认 1 */
	steamFeeMinimum: number;
	/** wallet_fee_base(分),默认 0 */
	steamFeeBase: number;
	/** 发行商费率,默认 0.10 */
	publisherFeePercent: number;
}

export const DEFAULT_FEES: Readonly<FeeConfig> = Object.freeze({
	steamFeePercent: 0.05,
	steamFeeMinimum: 1,
	steamFeeBase: 0,
	publisherFeePercent: 0.10
});

export interface FeeBreakdown {
	/** 买家付的总价(分) */
	buyerPrice: number;
	/** 卖家到手(分),即 sellitem 的 price */
	receive: number;
	steamFee: number;
	publisherFee: number;
	/** steamFee + publisherFee */
	fees: number;
}

function config(fees?: Partial<FeeConfig>): FeeConfig {
	return {...DEFAULT_FEES, ...fees};
}

/** CalculateAmountToSendForDesiredReceivedAmount:想到手 receive 分,买家要付多少 */
export function buyerPriceForReceive(receive: number, fees?: Partial<FeeConfig>): FeeBreakdown {
	const c = config(fees);
	const steamFee = Math.floor(Math.max(receive * c.steamFeePercent, c.steamFeeMinimum) + c.steamFeeBase);
	const publisherFee = Math.floor(c.publisherFeePercent > 0 ? Math.max(receive * c.publisherFeePercent, 1) : 0);
	return {buyerPrice: receive + steamFee + publisherFee, receive, steamFee, publisherFee, fees: steamFee + publisherFee};
}

/**
 * CalculateFeeAmount:买家付 buyerPrice 分时的手续费拆分(到手 = buyerPrice − fees)。
 * 先按比例估一个到手价,再一分一分地调,直到正算回来正好等于 buyerPrice;
 * 有的买家价怎么调都凑不上(跳过了),这时用小一分的到手价、把差额算进 Steam 手续费(和 Steam 一样)
 */
export function receiveForBuyerPrice(buyerPrice: number, fees?: Partial<FeeConfig>): FeeBreakdown {
	const c = config(fees);
	let estimate = Math.trunc((buyerPrice - c.steamFeeBase) / (c.steamFeePercent + c.publisherFeePercent + 1));
	let everUndershot = false;
	let result = buyerPriceForReceive(estimate, c);
	for (let i = 0; result.buyerPrice !== buyerPrice && i < 10; i++) {
		if (result.buyerPrice > buyerPrice) {
			if (everUndershot) {
				result = buyerPriceForReceive(estimate - 1, c);
				const gap = buyerPrice - result.buyerPrice;
				result.steamFee += gap;
				result.fees += gap;
				result.buyerPrice = buyerPrice;
				break;
			}
			estimate--;
		} else {
			everUndershot = true;
			estimate++;
		}
		result = buyerPriceForReceive(estimate, c);
	}
	return {...result, receive: result.buyerPrice - result.fees};
}

/** 买家价最低 3 分(到手 1 分,两项手续费各 1 分) */
export const MIN_RECEIVE_CENTS = 1;
