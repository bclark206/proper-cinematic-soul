import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

const PrivacyPolicy = () => {
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
              Privacy Policy
            </h1>
          </div>

          <div className="bg-charcoal/50 rounded-lg p-8 border border-gold/20 prose prose-invert max-w-none">
            <div className="text-cream space-y-6">
              <div>
                <p className="text-sm text-cream/70 mb-4">Effective Date: 1/12/2024</p>
                <p>
                  Proper Cuisine ("we," "our," or "us") respects your privacy and is committed to protecting the personal information you share with us. This Privacy Policy explains how we collect, use, and protect your information when you sign up to receive SMS messages, make reservations, or otherwise interact with our services.
                </p>
              </div>

              <div>
                <h2 className="text-2xl font-semibold text-gold mb-4">1. Information We Collect</h2>
                <ul className="space-y-2 ml-6">
                  <li className="flex items-start">
                    <span className="text-gold mr-2">•</span>
                    <span><strong className="text-pure-white">Personal Information:</strong> Name, phone number, reservation details, and any information you provide when signing up for SMS notifications or promotions.</span>
                  </li>
                  <li className="flex items-start">
                    <span className="text-gold mr-2">•</span>
                    <span><strong className="text-pure-white">Automatically Collected Information:</strong> We may collect non-identifiable information such as delivery reports and message interactions.</span>
                  </li>
                </ul>
              </div>

              <div>
                <h2 className="text-2xl font-semibold text-gold mb-4">2. How We Use Your Information</h2>
                <p className="mb-4">We use your information to:</p>
                <ul className="space-y-2 ml-6">
                  <li className="flex items-start">
                    <span className="text-gold mr-2">•</span>
                    <span>Send you reservation confirmations, updates, and reminders.</span>
                  </li>
                  <li className="flex items-start">
                    <span className="text-gold mr-2">•</span>
                    <span>Send you special offers, promotions, and event announcements (only if you have opted in).</span>
                  </li>
                  <li className="flex items-start">
                    <span className="text-gold mr-2">•</span>
                    <span>Improve our services, track message performance, and enhance customer support.</span>
                  </li>
                </ul>
              </div>

              <div>
                <h2 className="text-2xl font-semibold text-gold mb-4">3. Sharing of Information</h2>
                <p className="mb-4">We do not sell or rent your personal information. We may share your information with:</p>
                <ul className="space-y-2 ml-6">
                  <li className="flex items-start">
                    <span className="text-gold mr-2">•</span>
                    <span>Service providers (such as our SMS provider Twilio) to deliver messages.</span>
                  </li>
                  <li className="flex items-start">
                    <span className="text-gold mr-2">•</span>
                    <span>Legal authorities, if required by law or to protect our rights.</span>
                  </li>
                </ul>
              </div>

              <div>
                <h2 className="text-2xl font-semibold text-gold mb-4">4. Your Choices</h2>
                <ul className="space-y-2 ml-6">
                  <li className="flex items-start">
                    <span className="text-gold mr-2">•</span>
                    <span>You may opt out of SMS at any time by replying STOP to any message.</span>
                  </li>
                  <li className="flex items-start">
                    <span className="text-gold mr-2">•</span>
                    <span>You may request access, correction, or deletion of your personal information by contacting us at info@propercuisine.com.</span>
                  </li>
                </ul>
              </div>

              <div>
                <h2 className="text-2xl font-semibold text-gold mb-4">5. Data Security</h2>
                <p>
                  We use reasonable administrative, technical, and physical safeguards to protect your information. However, no system is 100% secure, and we cannot guarantee absolute security.
                </p>
              </div>

              <div>
                <h2 className="text-2xl font-semibold text-gold mb-4">6. Changes to Policy</h2>
                <p>
                  We may update this Privacy Policy from time to time. Updates will be posted at propercuisine.com.
                </p>
              </div>

              <div>
                <h2 className="text-2xl font-semibold text-gold mb-4">7. Contact Us</h2>
                <p className="mb-4">If you have questions about this Privacy Policy, please contact us:</p>
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

export default PrivacyPolicy;