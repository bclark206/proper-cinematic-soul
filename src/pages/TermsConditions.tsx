import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

const TermsConditions = () => {
  return (
    <div className="min-h-screen bg-gradient-to-br from-jet-black via-charcoal to-jet-black">
      <div className="container mx-auto px-6 py-12">
        <Link 
          to="/" 
          className="inline-flex items-center text-gold hover:text-gold/80 transition-colors mb-8"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Home
        </Link>
        
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-12">
            <h1 className="text-4xl md:text-5xl font-display font-bold text-pure-white mb-6">
              SMS Terms & Conditions
            </h1>
          </div>

          <div className="bg-charcoal/50 rounded-lg p-8 border border-gold/20 prose prose-invert max-w-none">
            <div className="text-cream space-y-6">
              <div>
                <p className="text-sm text-cream/70 mb-4">Effective Date: 1/12/2023</p>
                <p className="mb-6">
                  By opting in to receive SMS messages from Proper Cuisine, you agree to the following terms:
                </p>
              </div>

              <div>
                <h2 className="text-2xl font-semibold text-gold mb-4">1. Program Description</h2>
                <p className="mb-4">We send SMS messages to provide:</p>
                <ul className="space-y-2 ml-6">
                  <li className="flex items-start">
                    <span className="text-gold mr-2">•</span>
                    <span>Reservation confirmations, reminders, changes, and waitlist updates.</span>
                  </li>
                  <li className="flex items-start">
                    <span className="text-gold mr-2">•</span>
                    <span>Special offers, promotions, and event announcements (if you have opted in).</span>
                  </li>
                </ul>
              </div>

              <div>
                <h2 className="text-2xl font-semibold text-gold mb-4">2. Consent & Opt-In</h2>
                <p>
                  By providing your phone number through our website, QR code, or by phone, you consent to receive recurring SMS messages from Proper Cuisine. Message frequency may vary. Consent is not required as a condition of purchase.
                </p>
              </div>

              <div>
                <h2 className="text-2xl font-semibold text-gold mb-4">3. Opt-Out & Help</h2>
                <ul className="space-y-2 ml-6">
                  <li className="flex items-start">
                    <span className="text-gold mr-2">•</span>
                    <span>To opt out, reply <strong className="text-pure-white">STOP</strong> to any message. You will receive a confirmation message, and no further SMS will be sent.</span>
                  </li>
                  <li className="flex items-start">
                    <span className="text-gold mr-2">•</span>
                    <span>To request assistance, reply <strong className="text-pure-white">HELP</strong> or contact us at info@propercuisine.com.</span>
                  </li>
                </ul>
              </div>

              <div>
                <h2 className="text-2xl font-semibold text-gold mb-4">4. Message & Data Rates</h2>
                <p>
                  Message and data rates may apply depending on your mobile plan. Proper Cuisine is not responsible for charges incurred by your carrier.
                </p>
              </div>

              <div>
                <h2 className="text-2xl font-semibold text-gold mb-4">5. Privacy</h2>
                <p>
                  Your information will be handled in accordance with our{" "}
                  <Link to="/privacy-policy" className="text-gold hover:underline font-semibold">
                    Privacy Policy
                  </Link>.
                </p>
              </div>

              <div>
                <h2 className="text-2xl font-semibold text-gold mb-4">6. Liability</h2>
                <p>
                  SMS delivery is subject to your carrier&apos;s availability. We are not liable for delayed or undelivered messages.
                </p>
              </div>

              <div>
                <h2 className="text-2xl font-semibold text-gold mb-4">7. Changes to Terms</h2>
                <p>
                  We may revise these Terms from time to time. Updates will be posted at propercuisine.com. Continued use of our SMS program after changes constitutes acceptance of the revised Terms.
                </p>
              </div>

              <div>
                <h2 className="text-2xl font-semibold text-gold mb-4">8. Contact Us</h2>
                <p className="mb-4">For questions or concerns, contact:</p>
                <div className="bg-jet-black/50 rounded-lg p-6 border border-gold/30">
                  <p className="font-semibold text-gold mb-2">Proper Cuisine</p>
                  <p><strong>Email:</strong> info@propercuisine.com</p>
                  <p><strong>Phone:</strong> 443-432-2771</p>
                  <p><strong>Website:</strong> propercuisine.com</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TermsConditions;