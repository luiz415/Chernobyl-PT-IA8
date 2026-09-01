export interface Donation {
  id: string;
  userId?: string;
  userName: string;
  userEmail: string;
  amount: number;
  fromCharacter: string;
  toCharacter: string;
  donationDate: string;
  createdAt: string;
  status: "pendente" | "aprovado" | "recusado";
  approvedBy?: string;
  approvedByName?: string;
  approvedAt?: string;
}
