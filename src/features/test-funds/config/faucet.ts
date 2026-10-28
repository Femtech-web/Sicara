import type {Address} from 'viem';
// Dedicated Sepolia faucet; separately prefunded and live delivery verified.
export const demoTokenFaucetAddress:Address|undefined='0x2C043ADE6bC458839235D3E4cd892e72fB0B899c';
export const faucetAbi=[
  {type:'function',name:'claim',stateMutability:'nonpayable',inputs:[],outputs:[]},
  {type:'function',name:'nextClaimAt',stateMutability:'view',inputs:[{name:'account',type:'address'}],outputs:[{name:'',type:'uint256'}]},
] as const;

export const faucetAddresses:Record<"demo-zama"|"cusdc",Address|undefined>={"demo-zama":demoTokenFaucetAddress,cusdc:"0xE95D2095dA1d4aa487Dd730F8E75d1ED80049CC1"};
